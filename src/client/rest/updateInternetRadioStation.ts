import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
import { InternetRadioStation } from '../../zod.ts';

const updateInternetRadioStation = new Hono();

async function handleUpdateInternetRadioStation(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const id = await getField(c, 'id');
    const streamUrl = await getField(c, 'streamUrl');
    const name = await getField(c, 'name');
    const homepageUrl = await getField(c, 'homepageUrl');

    if (!id) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });
    if (!streamUrl) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'streamUrl'" });
    if (!name) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'name'" });

    const existingStation = (await database.get(['radioStations', id])).value as InternetRadioStation | null;
    if (!existingStation) return createResponse(c, {}, 'failed', { code: 30, message: 'Internet radio station not found' });

    // Validate stream URL
    const isValidStream = await new Promise<boolean>((resolve) => {
        fetch(streamUrl).then((response) => {
            resolve(response.ok);
        }).catch(() => {
            resolve(false);
        });
    });

    if (!isValidStream) return createResponse(c, {}, 'failed', { code: 20, message: 'Invalid stream URL' });

    existingStation.homepageUrl = homepageUrl || undefined;
    existingStation.name = name;
    existingStation.steamUrl = streamUrl;

    await database.set(['radioStations', id], existingStation);

    return createResponse(c, {}, 'ok');
}

updateInternetRadioStation.get('/updateInternetRadioStation', handleUpdateInternetRadioStation);
updateInternetRadioStation.post('/updateInternetRadioStation', handleUpdateInternetRadioStation);
updateInternetRadioStation.get('/updateInternetRadioStation.view', handleUpdateInternetRadioStation);
updateInternetRadioStation.post('/updateInternetRadioStation.view', handleUpdateInternetRadioStation);

export default updateInternetRadioStation;
