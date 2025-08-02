import { logger } from './util.ts';

export class MpvPlayer {
    private process?: Deno.ChildProcess;
    private ipcSocketPath: string;
    private connection?: Deno.Conn;
    private writer?: WritableStreamDefaultWriter<Uint8Array>;
    private isStopping = false;

    constructor() {
        this.ipcSocketPath = Deno.build.os === "windows"
            ? `\\\\.\\pipe\\mpv-socket-${Date.now()}`
            : `${Deno.makeTempDirSync()}/mpv-socket`;
    }

    async start() {
        if (this.process) {
            logger.warn("Player process is already running.");
            return;
        }

        logger.debug(`Starting mpv with IPC socket at: ${this.ipcSocketPath}`);

        this.process = new Deno.Command("mpv", {
            args: [
                "--no-video",
                "--idle",
                "--quiet",
                `--input-ipc-server=${this.ipcSocketPath}`,
            ],
            stdout: "null",
            stderr: "null",
        }).spawn();

        await (new Promise((rs) => setTimeout(rs, 500)));

        try {
            this.connection = await Deno.connect({
                path: this.ipcSocketPath,
                transport: "unix",
            });
            this.writer = this.connection.writable.getWriter();
            logger.info("Successfully connected to mpv IPC socket.");
            // deno-lint-ignore no-explicit-any
        } catch (err: any) {
            logger.error("Failed to connect to mpv IPC socket:", err.message);
            this.stop();
        }
    }

    private async sendCommand(command: object) {
        if (!this.writer) {
            logger.error("Cannot send command: Player is not connected.");
            return;
        }
        const commandString = JSON.stringify(command) + '\n';
        await this.writer.write(new TextEncoder().encode(commandString));
    }

    async play(filePath: string, startOffset = 0) {
        await this.sendCommand({
            command: ["loadfile", filePath, "replace"],
        });
        if (startOffset > 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
            await this.seek(startOffset);
        }
    }

    async setPause(paused: boolean) {
        await this.sendCommand({
            command: ["set_property", "pause", paused],
        });
    }

    async seek(seconds: number) {
        await this.sendCommand({
            command: ["seek", seconds, "absolute"],
        });
    }

    async setVolume(gain: number) {
        const volume = Math.round(gain * 100);
        await this.sendCommand({
            command: ["set_property", "volume", volume],
        });
    }

    async stopPlayback() {
        await this.sendCommand({ command: ["stop"] });
    }

    async stop() {
        if (this.isStopping || !this.process) {
            return;
        }
        this.isStopping = true;
        logger.info("Stopping player process...");

        if (this.writer) {
            await this.sendCommand({ command: ["quit"] });
            this.writer.releaseLock();
        }

        if (this.connection) {
            try {
                this.connection.close();
            } catch (error) {
                if (!(error instanceof Deno.errors.BadResource)) {
                    throw error;
                }
            }
        }

        try {
            this.process.kill();
            await this.process.status;
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) {
                console.error("Error killing mpv process:", error);
            }
        }

        try {
            if (Deno.build.os !== "windows") {
                await Deno.remove(this.ipcSocketPath, { recursive: true });
            }
        } catch {
            // Ignore errors if the file doesn't exist
        }

        this.process = undefined;
        this.connection = undefined;
        this.writer = undefined;
        logger.info("Player process stopped.");
    }
}