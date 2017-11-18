import * as os from "os";
import * as path from "path";
import * as fs from "./fileSystem";
import * as tar from "tar";
import * as Debug from "debug";
import { httpDownload } from "./httpUtils";
const debug = Debug("live-plugin-manager.TarballUtils");

export async function extractTarball(tgzFile: string, destinationDirectory: string) {
	debug(`Extracting ${tgzFile} to ${destinationDirectory} ...`);

	await fs.ensureDir(destinationDirectory);

	await tar.extract({
		file: tgzFile,
		cwd: destinationDirectory,
		strip: 1
	});
}

export async function downloadTarball(url: string): Promise<string> {
	const destinationFile = path.join(os.tmpdir(), Date.now().toString() + ".tgz");

	// delete file if exists
	if (await fs.exists(destinationFile)) {
		await fs.remove(destinationFile);
	}

	debug(`Downloading ${url} to ${destinationFile} ...`);

	await httpDownload(url, destinationFile);

	return destinationFile;
}