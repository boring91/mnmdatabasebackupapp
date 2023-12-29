import cliProgress from 'cli-progress';

// create new container
const multibar = new cliProgress.MultiBar(
    {
        clearOnComplete: false,
        hideCursor: true,
        format: ' {bar} | {filename} | {value}/{total}',
    },
    cliProgress.Presets.shades_grey
);

// add bars
const b1 = multibar.create(200, 0);
const b2 = multibar.create(1000, 0);

b2.update(20, { filename: 'test1.txt' });
b1.update(20, { filename: 'helloworld.txt' });

setTimeout(() => {
    // control bars
    b2.update(40, { filename: 'test1.txt' });
    b1.update(40, { filename: 'helloworld.txt' });
}, 2000);

setTimeout(() => {
    // control bars
    b2.update(50, { filename: 'test1.txt' });
    b1.update(50, { filename: 'helloworld.txt' });
}, 3000);

console.log('here')

// stop all bars
// multibar.stop();
