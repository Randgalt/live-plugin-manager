import * as fs from "./fileSystem";
import * as path from "path";
import {NpmRegistryClient, NpmRegistryConfig} from "./NpmRegistryClient";
import {PluginVm} from "./PluginVm";
import {IPluginInfo} from "./PluginInfo";
import * as lockFile from "lockfile";
import * as semver from "semver";
import * as Debug from "debug";
import { GithubRegistryClient } from "./GithubRegistryClient";
import * as GitHubApi from "github";
import { PackageJsonInfo, PackageInfo } from "./PackageInfo";
const debug = Debug("live-plugin-manager");

const BASE_NPM_URL = "https://registry.npmjs.org";
const DefaultMainFile = "index.js";

export interface PluginManagerOptions {
	cwd: string;
	pluginsPath: string;
	sandbox: PluginSandbox;
	npmRegistryUrl: string;
	npmRegistryConfig: NpmRegistryConfig;
	requireCoreModules: boolean;
	hostRequire?: NodeRequire;
	ignoredDependencies: Array<string | RegExp>;
	staticDependencies: { [key: string]: any; };
	githubAuthentication?: GitHubApi.Auth;
	lockWait: number;
	lockStale: number;
}

export interface PluginSandbox {
	env?: NodeJS.ProcessEnv;
	global?: NodeJS.Global;
}

const cwd = process.cwd();
const DefaultOptions: PluginManagerOptions = {
	cwd,
	npmRegistryUrl: BASE_NPM_URL,
	sandbox: {},
	npmRegistryConfig: {},
	pluginsPath: path.join(cwd, "plugin_packages"),
	requireCoreModules: true,
	hostRequire: require,
	ignoredDependencies: [/^@types\//],
	staticDependencies: {},
	lockWait: 120000,
	lockStale: 180000,
};

const NPM_LATEST_TAG = "latest";

export interface InstallFromPathOptions {
	force: boolean;
}

export class PluginManager {
	readonly options: PluginManagerOptions;
	private readonly vm: PluginVm;
	private readonly installedPlugins = new Array<IPluginInfo>();
	private readonly npmRegistry: NpmRegistryClient;
	private readonly githubRegistry: GithubRegistryClient;

	constructor(options?: Partial<PluginManagerOptions>) {
		if (options && !options.pluginsPath && options.cwd) {
			options.pluginsPath = path.join(options.cwd, "plugin_packages");
		}

		this.options = {...DefaultOptions, ...(options || {})};
		this.vm = new PluginVm(this);
		this.npmRegistry = new NpmRegistryClient(this.options.npmRegistryUrl, this.options.npmRegistryConfig);
		this.githubRegistry = new GithubRegistryClient(this.options.githubAuthentication);
	}

	async install(name: string, version?: string): Promise<IPluginInfo> {
		await fs.ensureDir(this.options.pluginsPath);

		await this.syncLock();
		try {
			return await this.installLockFree(name, version);
		} finally {
			await this.syncUnlock();
		}
	}

	/**
	 * Install a package from npm
	 * @param name name of the package
	 * @param version version of the package, default to "latest"
	 */
	async installFromNpm(name: string, version = NPM_LATEST_TAG): Promise<IPluginInfo> {
		await fs.ensureDir(this.options.pluginsPath);

		await this.syncLock();
		try {
			return await this.installFromNpmLockFree(name, version);
		} finally {
			await this.syncUnlock();
		}
	}

	/**
	 * Install a package from a local folder
	 * @param location package local folder location
	 * @param options options, if options.force == true then package is always reinstalled without version checking
	 */
	async installFromPath(location: string, options: Partial<InstallFromPathOptions> = {}): Promise<IPluginInfo> {
		await fs.ensureDir(this.options.pluginsPath);

		await this.syncLock();
		try {
			return await this.installFromPathLockFree(location, options);
		} finally {
			await this.syncUnlock();
		}
	}

	async installFromGithub(repository: string): Promise<IPluginInfo> {
		await fs.ensureDir(this.options.pluginsPath);

		await this.syncLock();
		try {
			return await this.installFromGithubLockFree(repository);
		} finally {
			await this.syncUnlock();
		}
	}

	/**
	 * Install a package by specifiing code directly. If no version is specified it will be always reinstalled.
	 * @param name plugin name
	 * @param code code to be loaded, equivalent to index.js
	 * @param version optional version, if omitted no version check is performed
	 */
	async installFromCode(name: string, code: string, version?: string): Promise<IPluginInfo> {
		await fs.ensureDir(this.options.pluginsPath);

		await this.syncLock();
		try {
			return await this.installFromCodeLockFree(name, code, version);
		} finally {
			await this.syncUnlock();
		}
	}

	async uninstall(name: string): Promise<void> {
		await fs.ensureDir(this.options.pluginsPath);

		await this.syncLock();
		try {
			return await this.uninstallLockFree(name);
		} finally {
			await this.syncUnlock();
		}
	}

	async uninstallAll(): Promise<void> {
		await fs.ensureDir(this.options.pluginsPath);

		await this.syncLock();
		try {
			// TODO First I should install dependents plugins??
			for (const plugin of this.installedPlugins.slice().reverse()) {
				await this.uninstallLockFree(plugin.name);
			}
		} finally {
			await this.syncUnlock();
		}
	}

	list(): IPluginInfo[] {
		return this.installedPlugins.map((p) => p);
	}

	require(fullName: string): any {
		const {pluginName, requiredPath} = this.vm.splitRequire(fullName);

		const info = this.getFullInfo(pluginName);
		if (!info) {
			throw new Error(`${pluginName} not installed`);
		}

		let filePath: string | undefined;
		if (requiredPath) {
			filePath = this.vm.resolve(info, requiredPath);
		}

		return this.load(info, filePath);
	}

	alreadyInstalled(name: string, version?: string): IPluginInfo | undefined {
		const installedInfo = this.getInfo(name);
		if (installedInfo) {
			if (!version) {
				return installedInfo;
			}

			if (semver.satisfies(installedInfo.version, version)) {
				return installedInfo;
			}
		}

		return undefined;
	}

	getInfo(name: string): IPluginInfo | undefined {
		return this.getFullInfo(name);
	}

	queryPackage(name: string, version?: string): Promise<PackageInfo> {
		if (!this.isValidPluginName(name)) {
			throw new Error(`Invalid plugin name '${name}'`);
		}

		if (version && this.githubRegistry.isGithubRepo(version)) {
			return this.queryPackageFromGithub(version);
		}

		return this.queryPackageFromNpm(name, version);
	}

	queryPackageFromNpm(name: string, version = NPM_LATEST_TAG): Promise<PackageInfo> {
		if (!this.isValidPluginName(name)) {
			throw new Error(`Invalid plugin name '${name}'`);
		}

		return this.npmRegistry.get(name, version);
	}

	queryPackageFromGithub(repository: string): Promise<PackageInfo> {
		return this.githubRegistry.get(repository);
	}

	runScript(code: string): any {
		return this.vm.runScript(code);
	}

	getFullInfo(name: string): IPluginInfo | undefined {
		return this.installedPlugins.find((p) => p.name === name);
	}

	private async uninstallLockFree(name: string): Promise<void> {
		if (!this.isValidPluginName(name)) {
			throw new Error(`Invalid plugin name '${name}'`);
		}

		debug(`Uninstalling ${name}...`);

		const info = this.getFullInfo(name);
		if (!info) {
			debug(`${name} not installed`);
			return;
		}

		await this.deleteAndUnloadPlugin(info);
	}

	private async installLockFree(name: string, version?: string): Promise<IPluginInfo> {
		if (!this.isValidPluginName(name)) {
			throw new Error(`Invalid plugin name '${name}'`);
		}

		if (version && this.githubRegistry.isGithubRepo(version)) {
			return this.installFromGithubLockFree(version);
		}

		return this.installFromNpmLockFree(name, version);
	}

	private async installFromPathLockFree(
		location: string, options: Partial<InstallFromPathOptions>): Promise<IPluginInfo> {
		const packageJson = await this.readPackageJsonFromPath(location);

		if (!this.isValidPluginName(packageJson.name)) {
			throw new Error(`Invalid plugin name '${packageJson.name}'`);
		}

		// already installed satisfied version
		if (!options.force) {
			const installedInfo = this.alreadyInstalled(packageJson.name, packageJson.version);
			if (installedInfo) {
				return installedInfo;
			}
		}

		// already installed not satisfied version
		if (this.alreadyInstalled(packageJson.name)) {
			await this.uninstallLockFree(packageJson.name);
		}

		// already downloaded
		if (options.force || !(await this.isAlreadyDownloaded(packageJson.name, packageJson.version))) {
			await this.removeDownloaded(packageJson.name);

			debug(`Copy from ${location} to ${this.options.pluginsPath}`);
			await fs.copy(location, this.getPluginLocation(packageJson.name), { exclude: ["node_modules"] });
		}

		const pluginInfo = await this.createPluginInfo(packageJson.name);

		return this.addPlugin(pluginInfo);
	}

	private async installFromNpmLockFree(name: string, version = NPM_LATEST_TAG): Promise<IPluginInfo> {
		if (!this.isValidPluginName(name)) {
			throw new Error(`Invalid plugin name '${name}'`);
		}

		const registryInfo = await this.npmRegistry.get(name, version);

		// already installed satisfied version
		const installedInfo = this.alreadyInstalled(registryInfo.name, registryInfo.version);
		if (installedInfo) {
			return installedInfo;
		}

		// already installed not satisfied version
		if (this.alreadyInstalled(registryInfo.name)) {
			await this.uninstallLockFree(registryInfo.name);
		}

		// already downloaded
		if (!(await this.isAlreadyDownloaded(registryInfo.name, registryInfo.version))) {
			await this.removeDownloaded(registryInfo.name);

			await this.npmRegistry.download(
				this.options.pluginsPath,
				registryInfo);
		}

		const pluginInfo = await this.createPluginInfo(registryInfo.name);
		return this.addPlugin(pluginInfo);
	}

	private async installFromGithubLockFree(repository: string): Promise<IPluginInfo> {
		const registryInfo = await this.githubRegistry.get(repository);

		if (!this.isValidPluginName(registryInfo.name)) {
			throw new Error(`Invalid plugin name '${name}'`);
		}

		// already installed satisfied version
		const installedInfo = this.alreadyInstalled(registryInfo.name, registryInfo.version);
		if (installedInfo) {
			return installedInfo;
		}

		// already installed not satisfied version
		if (this.alreadyInstalled(registryInfo.name)) {
			await this.uninstallLockFree(registryInfo.name);
		}

		// already downloaded
		if (!(await this.isAlreadyDownloaded(registryInfo.name, registryInfo.version))) {
			await this.removeDownloaded(registryInfo.name);

			await this.githubRegistry.download(
				this.options.pluginsPath,
				registryInfo);
		}

		const pluginInfo = await this.createPluginInfo(registryInfo.name);
		return this.addPlugin(pluginInfo);
	}

	private async installFromCodeLockFree(name: string, code: string, version: string = "0.0.0"): Promise<IPluginInfo> {
		if (!this.isValidPluginName(name)) {
			throw new Error(`Invalid plugin name '${name}'`);
		}

		if (!semver.valid(version)) {
			throw new Error(`Invalid plugin version '${version}'`);
		}

		const packageJson: PackageInfo = {
			name,
			version
		};

		// already installed satisfied version
		if (version !== "0.0.0") {
			const installedInfo = this.alreadyInstalled(packageJson.name, packageJson.version);
			if (installedInfo) {
				return installedInfo;
			}
		}

		// already installed not satisfied version
		if (this.alreadyInstalled(packageJson.name)) {
			await this.uninstallLockFree(packageJson.name);
		}

		// already created
		if (!(await this.isAlreadyDownloaded(packageJson.name, packageJson.version))) {
			await this.removeDownloaded(packageJson.name);

			debug(`Create plugin ${name} to ${this.options.pluginsPath} from code`);

			const location = this.getPluginLocation(name);
			await fs.ensureDir(location);
			await fs.writeFile(path.join(location, DefaultMainFile), code);
			await fs.writeFile(path.join(location, "package.json"), JSON.stringify(packageJson));
		}

		const pluginInfo = await this.createPluginInfo(packageJson.name);
		return this.addPlugin(pluginInfo);
	}

	private async installDependencies(plugin: IPluginInfo): Promise<{ [name: string]: string }> {
		if (!plugin.dependencies) {
			return {};
		}

		const dependencies: { [name: string]: string } = {};

		for (const key in plugin.dependencies) {
			if (!plugin.dependencies.hasOwnProperty(key)) {
				continue;
			}
			if (this.shouldIgnore(key)) {
				continue;
			}

			const version = plugin.dependencies[key];

			if (this.isModuleAvailableFromHost(key, version)) {
				debug(`Installing dependencies of ${plugin.name}: ${key} is already available on host`);
			} else if (this.alreadyInstalled(key, version)) {
				debug(`Installing dependencies of ${plugin.name}: ${key} is already installed`);
			} else {
				debug(`Installing dependencies of ${plugin.name}: ${key} ...`);
				await this.installLockFree(key, version);
			}

			// NOTE: maybe here I should put the actual version?
			dependencies[key] = version;
		}

		return dependencies;
	}

	private unloadWithDependents(plugin: IPluginInfo) {
		this.unload(plugin);

		for (const installed of this.installedPlugins) {
			if (installed.dependencies[plugin.name]) {
				this.unloadWithDependents(installed);
			}
		}
	}

	private isModuleAvailableFromHost(name: string, version: string): boolean {
		if (!this.options.hostRequire) {
			return false;
		}

		// TODO Here I should check also if version is compatible?
		// I can resolve the module, get the corresponding package.json
		//  load it and get the version, then use
		// if (semver.satisfies(installedInfo.version, version))
		// to check if compatible...

		try {
			const modulePackage = this.options.hostRequire(name + "/package.json") as PackageInfo;
			return semver.satisfies(modulePackage.version, version);
		} catch (e) {
			return false;
		}
	}

	private isValidPluginName(name: string) {
		if (typeof name !== "string") {
			return false;
		}

		if (name.length === 0) {
			return false;
		}

		// '/' is permitted to support scoped packages
		if (name.startsWith(".")
		|| name.indexOf("\\") >= 0) {
			return false;
		}

		return true;
	}

	private getPluginLocation(name: string) {
		return path.join(this.options.pluginsPath, name);
	}

	private async removeDownloaded(name: string) {
		const location = this.getPluginLocation(name);
		if (!(await fs.directoryExists(location))) {
			await fs.remove(location);
		}
	}

	private async isAlreadyDownloaded(name: string, version: string): Promise<boolean> {
		const location = this.getPluginLocation(name);
		if (!(await fs.directoryExists(location))) {
			return false;
		}

		try {
			const packageJson = await this.readPackageJsonFromPath(location);

			return (packageJson.name === name && packageJson.version === version);
		} catch (e) {
			return false;
		}
	}

	private async readPackageJsonFromPath(location: string): Promise<PackageJsonInfo> {
		const packageJsonFile = path.join(location, "package.json");
		if (!(await fs.fileExists(packageJsonFile))) {
			throw new Error(`Invalid plugin ${location}, package.json is missing`);
		}
		const packageJson = JSON.parse(await fs.readFile(packageJsonFile, "utf8"));

		if (!packageJson.name
			|| !packageJson.version) {
			throw new Error(
				`Invalid plugin ${location}, 'main', 'name' and 'version' properties are required in package.json`);
		}

		return packageJson;
	}

	private load(plugin: IPluginInfo, filePath?: string): any {
		filePath = filePath || plugin.mainFile;

		debug(`Loading ${plugin.name}${filePath}...`);
		return this.vm.load(plugin, filePath);
	}

	private unload(plugin: IPluginInfo) {
		debug(`Unloading ${plugin.name}...`);
		this.vm.unload(plugin);
	}

	private async addPlugin(plugin: IPluginInfo): Promise<IPluginInfo> {
		await this.installDependencies(plugin);

		this.installedPlugins.push(plugin);

		return plugin;
	}

	private async deleteAndUnloadPlugin(plugin: IPluginInfo): Promise<void> {
		const index = this.installedPlugins.indexOf(plugin);
		if (index >= 0) {
			this.installedPlugins.splice(index, 1);
		}

		this.unloadWithDependents(plugin);

		await fs.remove(plugin.location);
	}

	private syncLock() {
		debug("Acquiring lock ...");

		const lockLocation = path.join(this.options.pluginsPath, "install.lock");
		return new Promise<void>((resolve, reject) => {
			lockFile.lock(lockLocation, { wait: this.options.lockWait, stale: this.options.lockStale }, (err) => {
				if (err) {
					debug("Failed to acquire lock", err);
					return reject("Failed to acquire lock: " + err.message);
				}

				resolve();
			});
		});
	}

	private syncUnlock() {
		debug("Releasing lock ...");

		const lockLocation = path.join(this.options.pluginsPath, "install.lock");
		return new Promise<void>((resolve, reject) => {
			lockFile.unlock(lockLocation, (err) => {
				if (err) {
					debug("Failed to release lock", err);
					return reject("Failed to release lock: " + err.message);
				}

				resolve();
			});
		});
	}

	private shouldIgnore(name: string): boolean {
		for (const p of this.options.ignoredDependencies) {
			let ignoreMe = false;
			if (p instanceof RegExp) {
				ignoreMe = p.test(name);
				if (ignoreMe) {
					return true;
				}
			}

			ignoreMe = new RegExp(p).test(name);
			if (ignoreMe) {
				return true;
			}
		}

		for (const key in this.options.staticDependencies) {
			if (!this.options.staticDependencies.hasOwnProperty(key)) {
				continue;
			}

			if (key === name) {
				return true;
			}
		}

		return false;
	}

	private async createPluginInfo(name: string): Promise<IPluginInfo> {
		const DefaultMainFileExtension = ".js";

		const location = this.getPluginLocation(name);
		const packageJson = await this.readPackageJsonFromPath(location);

		let mainFile = path.normalize(path.join(location, packageJson.main || DefaultMainFile));
		// If no extensions for main file is used, just default to .js
		if (!path.extname(mainFile)) {
			mainFile += DefaultMainFileExtension;
		}

		return {
			name: packageJson.name,
			version: packageJson.version,
			location,
			mainFile,
			dependencies: packageJson.dependencies || {}
		};
	}
}
