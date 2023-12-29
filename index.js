import https from 'https';
import fs from 'fs/promises';
import fsSync from 'fs';
import dotenv from 'dotenv';
import prettyBytes from 'pretty-bytes';
import cliProgress from 'cli-progress';
import colors from 'ansi-colors';
import { exit } from 'process';

dotenv.config();

const localDir = process.env.LOCAL_DIR;
const remoteDir = process.env.REMOTE_DIR;

// await backupPendingFiles();
// await upload('test.rar');
await uploadWithProgressBar('backupfile.txt');

async function backupPendingFiles() {
    logMessage(`Figuring out pending files...`);
    const pendingFiles = await getPendingUploadFiles();

    logMessage(`Found ${pendingFiles.length} pending files.`);

    for (let idx = 0; idx < pendingFiles.length; idx++) {
        const pendingFile = pendingFiles[idx];
        const fileSize = prettyBytes(
            (await fs.stat(`${localDir}/${pendingFile}`)).size
        );

        logMessage(
            `Uploading (${idx + 1}/${
                pendingFiles.length
            }) ${pendingFile} (size: ${fileSize})...`
        );

        await upload(pendingFile);
    }

    logMessage('Done.');
}

async function getPendingUploadFiles() {
    const localFiles = await getLocalBackupFiles();
    const remoteFiles = await getRemoteBackupFiles();

    return localFiles.filter(x => !remoteFiles.includes(x));
}

async function getRemoteBackupFiles() {
    try {
        return await new Promise((resolve, reject) => {
            const url = 'https://api.dropboxapi.com/2/files/list_folder';
            const data = JSON.stringify({
                'path': remoteDir,
                'limit': 2000,
            });

            const req = https.request(
                url,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.TOKEN}`,
                        'Content-Type': 'application/json',
                        'Content-Length': data.length,
                    },
                },
                res => {
                    let responseData = '';

                    res.setEncoding('utf8');

                    res.on('data', chunk => {
                        responseData += chunk;
                    });

                    res.on('end', () => {
                        try {
                            // Parse the received data as JSON
                            const jsonResponse = JSON.parse(responseData);
                            const files = jsonResponse.entries.map(x => x.name);
                            resolve(files);
                        } catch (error) {
                            reject(error);
                        }
                    });
                }
            );
            req.write(data);
            req.end();
        });
    } catch (error) {
        logMessage('Error parsing JSON: ' + error, true);
        exit(1);
    }
}

async function getLocalBackupFiles() {
    try {
        return await fs.readdir(localDir);
    } catch (error) {
        logMessage('Error reading directory: ' + error, true);
        exit(1);
    }
}

async function uploadWithProgressBar(filename) {
    // Create the progress bar:
    const progressBar = new cliProgress.SingleBar({
        format:
            'CLI Progress |' +
            colors.cyan('{bar}') +
            '| {percentage}% || {valuePretty}/{totalPretty} || Speed: {speed}',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
    });

    const onStart = async () => {
        // initialize the bar - defining payload token "speed" with the default value "N/A"
        const filePath = `${localDir}/${filename}`;
        const size = (await fs.stat(filePath)).size;

        progressBar.start(size, 0, {
            speed: 'N/A',
            valuePretty: '0 B',
            totalPretty: prettyBytes(size),
        });
    };

    let startTime = new Date();
    let startOffset = 0;
    const onPreUpload = async offset => {
        startTime = new Date();
        startOffset = offset;
    };

    const onPostUpload = async offset => {
        // Compute speed
        const endTime = new Date();
        const elapsed = (endTime - startTime) / 1000;
        const speed = (offset - startOffset) / elapsed;

        // update values
        progressBar.increment();
        progressBar.update(offset, {
            valuePretty: prettyBytes(offset),
            speed: prettyBytes(speed) + '/s',
        });
    };

    const onEnd = async () => {
        // stop the bar
        progressBar.stop();
    };

    return upload(filename, {
        onStart,
        onPreUpload,
        onPostUpload,
        onEnd,
    });
}

async function upload(
    filename,
    { onStart = null, onPreUpload = null, onPostUpload = null, onEnd = null }
) {
    return new Promise((resolve, _) => {
        const baseUrl =
            'https://content.dropboxapi.com/2/files/upload_session/';

        const filePath = `${localDir}/${filename}`;

        const req = https.request(
            `${baseUrl}/start`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.TOKEN}`,
                    'Dropbox-API-Arg': JSON.stringify({
                        'close': false,
                    }),
                    'Content-Type': 'application/octet-stream',
                },
            },
            res => {
                res.on('data', async d => {
                    const json = JSON.parse(d.toString('utf8'));
                    const session_id = json.session_id;
                    let offset = 0;

                    const stream = fsSync.createReadStream(filePath);

                    if (onStart) await onStart();

                    stream.on('data', async chunk => {
                        stream.pause();

                        if (onPreUpload) await onPreUpload(offset);

                        const reqAppend = https.request(
                            `${baseUrl}/append_v2`,
                            {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${process.env.TOKEN}`,
                                    'Dropbox-API-Arg': JSON.stringify({
                                        'cursor': {
                                            'session_id': session_id,
                                            'offset': offset,
                                        },
                                        'close': false,
                                    }),
                                    'Content-Type': 'application/octet-stream',
                                },
                            },
                            async _ => {
                                if (onPostUpload) await onPostUpload(offset);

                                stream.resume();
                            }
                        );

                        reqAppend.write(chunk);
                        reqAppend.end();

                        offset += chunk.length;
                    });

                    stream.on('end', () => {
                        const reqFinish = https.request(
                            `${baseUrl}/finish`,
                            {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${process.env.TOKEN}`,
                                    'Dropbox-API-Arg': JSON.stringify({
                                        'cursor': {
                                            'session_id': session_id,
                                            'offset': offset,
                                        },
                                        'commit': {
                                            'path': `${remoteDir}/${filename}`,
                                            'mode': 'add',
                                            'autorename': true,
                                            'mute': false,
                                            'strict_conflict': false,
                                        },
                                    }),
                                    'Content-Type': 'application/octet-stream',
                                },
                            },
                            async res => {
                                if (onEnd) await onEnd();

                                if (res.statusCode !== 200) {
                                    logMessage(
                                        'statusCode: ',
                                        res.statusCode,
                                        true
                                    );
                                    res.on('data', chunk => {
                                        logMessage('BODY: ' + chunk, true);
                                    });
                                }

                                resolve();
                            }
                        );

                        reqFinish.end();
                    });
                });
            }
        );

        req.end();
    });
}

function logMessage(message, isError = false) {
    const now = new Date().toISOString();
    const messageWithTime = `[${now}] ${message}`;

    if (isError) console.error(messageWithTime);
    else console.log(messageWithTime);
}
