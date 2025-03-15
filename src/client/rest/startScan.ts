import { Context, Hono } from 'hono';
import { createResponse, validateAuth } from '../../util.ts';
import { StartScan } from '../../MediaScanner.ts';

const startScan = new Hono();

async function handlestartScan(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    return createResponse(c, { scanStatus: StartScan() }, 'ok');
}

startScan.get('/startScan', handlestartScan);
startScan.post('/startScan', handlestartScan);
startScan.get('/startScan.view', handlestartScan);
startScan.post('/startScan.view', handlestartScan);

export default startScan;
