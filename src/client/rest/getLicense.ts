import { Context, Hono } from 'hono';
import { createResponse, validateAuth } from '../../util.ts';

const getLicense = new Hono();

async function handlegetLicense(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    return createResponse(c, {
        license: {
            valid: true,
            email: 'rapidfugegt1@gmail.com',
            licenseExpire: new Date(8.64e15).toString(),
        },
    }, 'ok');
}

getLicense.get('/getLicense', handlegetLicense);
getLicense.post('/getLicense', handlegetLicense);
getLicense.get('/getLicense.view', handlegetLicense);
getLicense.post('/getLicense.view', handlegetLicense);

export default getLicense;
