import { Context, Hono } from '@hono/hono';
import { Song } from '../../zod.ts';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
import { MpvPlayer } from '../../player.ts';

const jukebox = new Hono();
const player = new MpvPlayer();

player.start();

Deno.addSignalListener('SIGINT', async () => {
    console.log('Caught interrupt signal. Shutting down player...');
    await player.stop();
    Deno.exit();
});

const jukeboxState: {
    playlist: Song[];
    currentIndex: number;
    playing: boolean;
    gain: number;
    startTime: number | null;
    pausedPosition: number | null;
} = {
    playlist: [],
    currentIndex: -1,
    playing: false,
    gain: 1.0,
    startTime: null,
    pausedPosition: null,
};

function getCurrentPosition(): number {
    if (!jukeboxState.playing && jukeboxState.pausedPosition !== null) {
        return jukeboxState.pausedPosition;
    }

    if (jukeboxState.playing && jukeboxState.startTime && jukeboxState.currentIndex > -1) {
        const currentSong = jukeboxState.playlist[jukeboxState.currentIndex];
        if (!currentSong) return 0;
        const elapsedSeconds = (Date.now() - jukeboxState.startTime) / 1000;
        return Math.min(Math.floor(elapsedSeconds), currentSong.subsonic.duration);
    }
    return 0;
}

function getJukeboxStatus() {
    return {
        currentIndex: jukeboxState.currentIndex,
        playing: jukeboxState.playing,
        gain: jukeboxState.gain,
        position: getCurrentPosition(),
    };
}

function getJukeboxPlaylist() {
    return {
        ...getJukeboxStatus(),
        entry: jukeboxState.playlist.map((song) => song.subsonic),
    };
}

function shufflePlaylist() {
    let currentIndex = jukeboxState.playlist.length;
    let randomIndex;

    while (currentIndex !== 0) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;

        [jukeboxState.playlist[currentIndex], jukeboxState.playlist[randomIndex]] = [
            jukeboxState.playlist[randomIndex],
            jukeboxState.playlist[currentIndex],
        ];
    }
}

async function handleJukeboxControl(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    // if (!isValidated.jukeboxRole) {
    //     return createResponse(c, {}, 'failed', { code: 50, message: 'User not authorized for jukebox control' });
    // }

    const action = await getField(c, 'action') || 'status';
    const id = await getField(c, 'id');
    const ids = c.req.queries('id');
    const index = parseInt(await getField(c, 'index') || '-1');
    const offset = parseInt(await getField(c, 'offset') || '0');
    const gain = parseFloat(await getField(c, 'gain') || '-1');

    switch (action) {
        case 'get': {
            return createResponse(c, { jukeboxPlaylist: getJukeboxPlaylist() });
        }

        case 'status': {
            return createResponse(c, { jukeboxStatus: getJukeboxStatus() });
        }

        case 'start': {
            if (!jukeboxState.playing && jukeboxState.currentIndex > -1) {
                jukeboxState.playing = true;

                const resumeOffset = jukeboxState.pausedPosition || 0;
                jukeboxState.startTime = Date.now() - (resumeOffset * 1000);
                jukeboxState.pausedPosition = null;

                await player.setPause(false);
            }
            return createResponse(c, { jukeboxStatus: getJukeboxStatus() });
        }

        case 'stop': {
            if (jukeboxState.playing) {
                jukeboxState.pausedPosition = getCurrentPosition();

                jukeboxState.playing = false;
                jukeboxState.startTime = null;
                await player.setPause(true);
            }
            return createResponse(c, { jukeboxStatus: getJukeboxStatus() });
        }

        case 'skip': {
            if (index >= 0 && index < jukeboxState.playlist.length) {
                jukeboxState.currentIndex = index;
                jukeboxState.playing = true;
                jukeboxState.startTime = Date.now() - (offset * 1000);
                jukeboxState.pausedPosition = null;
                const songToPlay = jukeboxState.playlist[index];
                if (songToPlay) {
                    await player.play(songToPlay.subsonic.path, offset);
                }
            }
            return createResponse(c, { jukeboxStatus: getJukeboxStatus() });
        }

        case 'add': {
            const songIdsToAdd = ids || (id ? [id] : []);
            if (songIdsToAdd.length > 0) {
                for (const songId of songIdsToAdd) {
                    const track = (await database.get(['tracks', songId])).value as Song | null;
                    if (track) {
                        jukeboxState.playlist.push(track);
                    }
                }
                if (jukeboxState.currentIndex === -1 && jukeboxState.playlist.length > 0) {
                    jukeboxState.currentIndex = 0;
                }
            }
            return createResponse(c, { jukeboxStatus: getJukeboxStatus() });
        }

        case 'set': {
            const previouslyPlayingSongId = jukeboxState.currentIndex > -1 ? jukeboxState.playlist[jukeboxState.currentIndex]?.subsonic.id : null;

            const songIdsToSet = ids || (id ? [id] : []);
            const newPlaylist: Song[] = [];

            if (songIdsToSet.length > 0) {
                for (const songId of songIdsToSet) {
                    const track = (await database.get(['tracks', songId])).value as Song | null;
                    if (track) {
                        newPlaylist.push(track);
                    }
                }
            }

            jukeboxState.playlist = newPlaylist;

            if (newPlaylist.length === 0) {
                jukeboxState.currentIndex = -1;
                jukeboxState.playing = false;
                jukeboxState.startTime = null;
                jukeboxState.pausedPosition = null;
                await player.stopPlayback();
                return createResponse(c, { jukeboxStatus: getJukeboxStatus() });
            }

            const newIndexOfOldSong = previouslyPlayingSongId ? newPlaylist.findIndex((song) => song.subsonic.id === previouslyPlayingSongId) : -1;

            if (newIndexOfOldSong !== -1) {
                jukeboxState.currentIndex = newIndexOfOldSong;
            } else {
                jukeboxState.currentIndex = 0;
                jukeboxState.playing = true;
                jukeboxState.startTime = Date.now();
                jukeboxState.pausedPosition = null;

                const songToPlay = newPlaylist[0];
                if (songToPlay) {
                    await player.play(songToPlay.subsonic.path, 0);
                }
            }

            return createResponse(c, { jukeboxStatus: getJukeboxStatus() });
        }

        case 'clear': {
            jukeboxState.playlist = [];
            jukeboxState.currentIndex = -1;
            jukeboxState.playing = false;
            jukeboxState.startTime = null;
            jukeboxState.pausedPosition = null;
            await player.stopPlayback();
            return createResponse(c, { jukeboxStatus: getJukeboxStatus() });
        }

        case 'remove': {
            if (index >= 0 && index < jukeboxState.playlist.length) {
                jukeboxState.playlist.splice(index, 1);
                if (index < jukeboxState.currentIndex) {
                    jukeboxState.currentIndex--;
                } else if (index === jukeboxState.currentIndex || jukeboxState.currentIndex >= jukeboxState.playlist.length) {
                    jukeboxState.playing = false;
                    jukeboxState.startTime = null;
                    jukeboxState.currentIndex = jukeboxState.playlist.length > 0 ? 0 : -1;
                    await player.stopPlayback();
                }
            }
            return createResponse(c, { jukeboxStatus: getJukeboxStatus() });
        }

        case 'shuffle': {
            shufflePlaylist();
            jukeboxState.currentIndex = jukeboxState.playlist.length > 0 ? 0 : -1;
            jukeboxState.playing = false;
            jukeboxState.startTime = null;
            await player.stopPlayback();
            return createResponse(c, { jukeboxStatus: getJukeboxStatus() });
        }

        case 'setGain': {
            if (gain >= 0.0 && gain <= 1.0) {
                jukeboxState.gain = gain;
                await player.setVolume(gain);
            }
            return createResponse(c, { jukeboxStatus: getJukeboxStatus() });
        }

        default:
            return createResponse(c, {}, 'failed', { code: 0, message: `Unsupported action: '${action}'` });
    }
}

jukebox.get('/jukeboxControl', handleJukeboxControl);
jukebox.post('/jukeboxControl', handleJukeboxControl);
jukebox.get('/jukeboxControl.view', handleJukeboxControl);
jukebox.post('/jukeboxControl.view', handleJukeboxControl);

export default jukebox;
