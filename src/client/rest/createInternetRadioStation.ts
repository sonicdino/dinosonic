import { Context, Hono } from '@hono/hono';
import { createResponse, database, generateId, getField, validateAuth } from '../../util.ts';
import { InternetRadioStation } from '../../zod.ts';
const createInternetRadioStation = new Hono();

async function handleCreateInternetRadioStation(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const streamUrl = await getField(c, 'streamUrl');
    const name = await getField(c, 'name');
    const homepageUrl = await getField(c, 'homepageUrl');

    if (!streamUrl) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'streamUrl'" });
    if (!name) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'name'" });

    // Validate stream URL
    const isValidStream = await new Promise<boolean>((resolve) => {
        fetch(streamUrl).then((response) => {
            resolve(response.ok);
        }).catch(() => {
            resolve(false);
        });
    });

    if (!isValidStream) return createResponse(c, {}, 'failed', { code: 20, message: 'Invalid stream URL' });

    const id = await generateId();
    const newStation: InternetRadioStation = {
        id,
        name,
        steamUrl: streamUrl,
        homepageUrl: homepageUrl || undefined,
    };

    await database.set(['radioStations', id], newStation);

    return createResponse(c, {}, 'ok');
}

createInternetRadioStation.get('/createInternetRadioStation', handleCreateInternetRadioStation);
createInternetRadioStation.post('/createInternetRadioStation', handleCreateInternetRadioStation);
createInternetRadioStation.get('/createInternetRadioStation.view', handleCreateInternetRadioStation);
createInternetRadioStation.post('/createInternetRadioStation.view', handleCreateInternetRadioStation);

export default createInternetRadioStation;
