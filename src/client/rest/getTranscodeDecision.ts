import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, logger, validateAuth } from '../../util.ts';
import { Song } from '../../zod.ts';
import * as path from '@std/path';

const getTranscodeDecision = new Hono();

interface StreamDetails {
    protocol: string;
    container: string;
    codec: string;
    audioChannels?: number;
    audioBitrate?: number;
    audioProfile?: string;
    audioSamplerate?: number;
    audioBitdepth?: number;
}

interface TranscodeDecisionResponse {
    canDirectPlay: boolean;
    canTranscode: boolean;
    transcodeReason?: string[];
    errorReason?: string;
    transcodeParams?: string;
    sourceStream?: StreamDetails;
    transcodeStream?: StreamDetails;
}

async function handleGetTranscodeDecision(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    if (!isValidated.streamRole) return createResponse(c, {}, 'failed', { code: 50, message: 'You have no permission to stream' });

    const mediaId = await getField(c, 'mediaId');
    if (!mediaId) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'mediaId'" });

    const mediaType = await getField(c, 'mediaType');
    if (!mediaType || (mediaType !== 'song' && mediaType !== 'podcast')) {
        return createResponse(c, {}, 'failed', { code: 10, message: "Invalid or missing parameter: 'mediaType'. Must be 'song' or 'podcast'" });
    }

    const track = (await database.get(['tracks', mediaId])).value as Song | null;
    if (!track) return createResponse(c, {}, 'failed', { code: 70, message: `${mediaType === 'song' ? 'Song' : 'Podcast'} not found` });

    let clientInfo;
    try {
        clientInfo = await c.req.json();
    } catch (_) {
        return createResponse(c, {}, 'failed', { code: 10, message: 'Invalid or missing JSON body with ClientInfo' });
    }

    const sourceContainer = path.extname(track.subsonic.path).substring(1).toLowerCase() || 'mp3';
    const sourceCodec = sourceContainer;
    const sourceStream: StreamDetails = {
        protocol: 'http',
        container: sourceContainer,
        codec: sourceCodec,
        audioChannels: track.subsonic.channelCount,
        audioBitrate: track.subsonic.bitRate ? track.subsonic.bitRate * 1000 : undefined,
        audioProfile: '',
        audioSamplerate: track.subsonic.samplingRate,
        audioBitdepth: track.subsonic.bitDepth,
    };

    let canDirectPlay = false;
    let canTranscode = false;
    const transcodeReason: string[] = [];

    if (clientInfo.directPlayProfiles && Array.isArray(clientInfo.directPlayProfiles)) {
        for (const profile of clientInfo.directPlayProfiles) {
            if (
                profile.containers?.includes(sourceContainer) &&
                profile.audioCodecs?.includes(sourceCodec)
            ) {
                if (profile.maxAudioChannels && track.subsonic.channelCount && track.subsonic.channelCount > profile.maxAudioChannels) {
                    transcodeReason.push(
                        `AudioChannelsExceeded: track has ${track.subsonic.channelCount} channels, profile max is ${profile.maxAudioChannels}`,
                    );
                    continue;
                }

                canDirectPlay = true;
                break;
            }
        }

        if (!canDirectPlay) {
            transcodeReason.push(`NoMatchingDirectPlayProfile: source container=${sourceContainer}, codec=${sourceCodec}`);
        }
    } else {
        transcodeReason.push('NoDirectPlayProfilesProvided');
    }

    if (clientInfo.transcodingProfiles && Array.isArray(clientInfo.transcodingProfiles)) {
        canTranscode = clientInfo.transcodingProfiles.length > 0;
    }

    const decision: TranscodeDecisionResponse = {
        canDirectPlay,
        canTranscode,
        transcodeReason: transcodeReason.length > 0 ? transcodeReason : undefined,
        errorReason: '',
        sourceStream,
    };

    if (canTranscode && !canDirectPlay && clientInfo.transcodingProfiles && clientInfo.transcodingProfiles.length > 0) {
        const targetProfile = clientInfo.transcodingProfiles[0];
        const targetBitrate = clientInfo.maxTranscodingAudioBitrate || 256000;
        const targetChannels = Math.min(targetProfile.maxAudioChannels || 2, track.subsonic.channelCount || 2);

        decision.transcodeParams = `${mediaId}-${targetProfile.container}-${targetBitrate}`;
        decision.transcodeStream = {
            protocol: targetProfile.protocol || 'http',
            container: targetProfile.container || 'mp3',
            codec: targetProfile.audioCodec || 'mp3',
            audioChannels: targetChannels,
            audioBitrate: targetBitrate,
            audioProfile: targetProfile.audioProfile || '',
            audioSamplerate: Math.min(48000, track.subsonic.samplingRate || 48000),
            audioBitdepth: 16,
        };
    }

    logger.debug(`Transcode decision for ${mediaType} ${mediaId}: canDirectPlay=${canDirectPlay}, canTranscode=${canTranscode}`);

    return createResponse(c, { transcodeDecision: decision }, 'ok');
}

getTranscodeDecision.post('/getTranscodeDecision', handleGetTranscodeDecision);
getTranscodeDecision.post('/getTranscodeDecision.view', handleGetTranscodeDecision);

export default getTranscodeDecision;
