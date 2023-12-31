import https from 'https';
import fs from 'fs/promises';
import fsSync from 'fs';
import dotenv from 'dotenv';
import prettyBytes from 'pretty-bytes';
import cliProgress from 'cli-progress';
import { exit } from 'process';

dotenv.config();

const localDir = process.env.LOCAL_DIR;
const remoteDir = process.env.REMOTE_DIR;
const accessToken = await getAccessToken();
const withBar = process.env.WITH_BAR ? true : false;

await backupPendingFiles();
// await upload('backupfile.txt');
// await uploadWithProgressBar('backupfile.txt');
// await multiUpload(['backupfile.txt', 'backupfile2.txt']);
// await multiUploadWithProgressBar(
//     ['backupfile.txt', 'backupfile2.txt', 'backupfile3.txt'],
//     withBar
// );

async function backupPendingFiles() {
    logMessage(`Figuring out pending files...`);
    const pendingFiles = await getPendingUploadFiles();

    logMessage(`Found ${pendingFiles.length} pending files.`);

    // for (let idx = 0; idx < pendingFiles.length; idx++) {
    //     const pendingFile = pendingFiles[idx];
    //     const fileSize = prettyBytes(
    //         (await fs.stat(`${localDir}/${pendingFile}`)).size
    //     );

    //     logMessage(
    //         `Uploading (${idx + 1}/${
    //             pendingFiles.length
    //         }) ${pendingFile} (size: ${fileSize})...`
    //     );

    //     await upload(pendingFile);
    // }

    await multiUploadWithProgressBar(pendingFiles, withBar);

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
                        'Authorization': `Bearer ${accessToken}`,
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
                            logMessage(error, true);
                            exit(0);
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

async function multiUploadWithProgressBar(filenames, withBar = true) {
    // create new container
    let multibar = null;

    if (withBar) {
        multibar = new cliProgress.MultiBar(
            {
                clearOnComplete: false,
                hideCursor: true,
                format: ' {bar} | {filename} | {percentage}% | {valuePretty}/{totalPretty} | {speed}',
            },
            cliProgress.Presets.shades_grey
        );
    }

    async function createPromise(filename) {
        const filePath = `${localDir}/${filename}`;
        const stats = await fs.stat(filePath);
        const size = stats.size;

        let bar = null;

        if (withBar) {
            bar = multibar.create(size, 0, {
                filename,
                valuePretty: prettyBytes(0),
                totalPretty: prettyBytes(size),
                speed: prettyBytes(0) + '/s',
            });
        } else {
            logMessage(`Uploading ${filename}...`);
        }

        await uploadWithProgressBar(filename, bar);

        const message = `Finished uploading ${filename}.`;
        if (withBar) {
            multibar.log(formatLogMessage(message) + '\n');
            multibar.remove(bar);
        } else {
            logMessage(message);
        }
    }

    const promiseGenerators = filenames.map(x => createPromise.bind(null, x));
    const maxConcurrentUploads = 5;

    await batch(promiseGenerators, maxConcurrentUploads);

    if (withBar) {
        multibar.stop();
    }
}

async function uploadWithProgressBar(filename, bar = null) {
    let startTime = new Date();
    let startOffset = 0;
    const onPreUpload = async offset => {
        startTime = new Date();
        startOffset = offset;
    };

    const onPostUpload = async offset => {
        if (!bar) return;

        // Compute speed
        const endTime = new Date();
        const elapsed = (endTime - startTime) / 1000;
        const speed = (offset - startOffset) / elapsed;

        // update values
        bar.increment();
        bar.update(offset, {
            valuePretty: prettyBytes(offset),
            speed: prettyBytes(speed || 0) + '/s',
        });
    };

    const onEnd = async () => {
        if (bar) {
            // stop the bar
            bar.stop();
        }
    };

    await upload(filename, {
        onPreUpload,
        onPostUpload,
        onEnd,
    });
}

async function upload(
    filename,
    { onPreUpload = null, onPostUpload = null, onEnd = null } = {
        onPreUpload: null,
        onPostUpload: null,
        onEnd: null,
    }
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
                    'Authorization': `Bearer ${accessToken}`,
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

                    const stream = fsSync.createReadStream(filePath, {
                        highWaterMark: 20 * 1024 * 1024,
                    });

                    stream.on('data', async chunk => {
                        stream.pause();

                        const reqAppend = https.request(
                            `${baseUrl}/append_v2`,
                            {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${accessToken}`,
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

                        if (onPreUpload) await onPreUpload(offset);
                        reqAppend.end();

                        offset += chunk.length;
                    });

                    stream.on('end', async () => {
                        const reqFinish = https.request(
                            `${baseUrl}/finish`,
                            {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${accessToken}`,
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

                        if (onPostUpload) await onPostUpload(offset);
                        reqFinish.end();
                    });
                });
            }
        );

        req.end();
    });
}

async function getAccessToken() {
    return new Promise((resolve, reject) => {
        const url = 'https://api.dropbox.com/oauth2/token';
        const req = https.request(
            url,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${btoa(
                        process.env.KEY + ':' + process.env.SECRET
                    )}`,
                },
            },
            res => {
                if (res.statusCode !== 200) {
                    logMessage('statusCode: ' + res.statusCode, true);
                    res.on('data', chunk => {
                        logMessage('BODY: ' + chunk, true);
                    });
                    exit(1);
                }

                let responseData = '';

                res.setEncoding('utf8');

                res.on('data', chunk => {
                    responseData += chunk;
                });

                res.on('end', () => {
                    try {
                        resolve(JSON.parse(responseData).access_token);
                    } catch (error) {
                        reject(error);
                    }
                });
            }
        );
        const data = `grant_type=refresh_token&refresh_token=${process.env.REFRESH_TOKEN}`;
        req.write(data);
        req.end();
    });
}

async function batch(tasks, batch_in_parallel) {
    let len = tasks.length;

    return new Promise((resolve, reject) => {
        let counter = len;

        function looper() {
            if (tasks.length === 0) return;

            // remove task from the front of the array:
            // note: alternatively you can use .pop()
            //       to process tasks from the back
            tasks
                .shift()()
                .then(() => {
                    counter--;
                    if (counter) {
                        // if we still have tasks
                        looper(); // process another task
                    } else {
                        // if there are no tasks left we are
                        // done so resolve the promise:
                        resolve();
                    }
                });
        }

        // Start parallel tasks:
        for (let i = 0; i < batch_in_parallel; i++) {
            looper();
        }
    });
}

function logMessage(message, isError = false) {
    if (isError) console.error(formatLogMessage(message));
    else console.log(formatLogMessage(message));
}

function formatLogMessage(message) {
    const now = new Date().toISOString();
    const formattedMessage = `[${now}] ${message}`;
    return formattedMessage;
}
