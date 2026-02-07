import { walk } from '@std/fs';
import { logger } from '../util.ts';

export interface ScannedFile {
    path: string;
    isFile: boolean;
}

export async function* scanAudioFiles(directories: string[]): AsyncGenerator<ScannedFile> {
    const SUPPORTED_EXTENSIONS = ['.flac', '.mp3', '.wav', '.ogg', '.m4a', '.opus'];

    for (const dir of directories) {
        logger.info(`🔍 Scanning directory: ${dir}`);

        try {
            for await (const entry of walk(dir, { exts: SUPPORTED_EXTENSIONS })) {
                if (entry.isFile) {
                    yield {
                        path: entry.path,
                        isFile: true,
                    };
                }
            }
        } catch (error) {
            logger.error(`Error scanning directory ${dir}: ${error}`);
        }
    }
}

export async function countAudioFiles(directories: string[]): Promise<number> {
    const SUPPORTED_EXTENSIONS = ['.flac', '.mp3', '.wav', '.ogg', '.m4a', '.opus'];
    let count = 0;

    for (const dir of directories) {
        try {
            for await (const _entry of walk(dir, { exts: SUPPORTED_EXTENSIONS })) {
                count++;
            }
        } catch (error) {
            logger.error(`Error counting files in ${dir}: ${error}`);
        }
    }

    return count;
}
