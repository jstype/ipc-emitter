import * as assert from 'assert';
import * as ipc from '..';
import * as child_process from 'child_process';

describe('single process', () => {
    afterEach(() => {
        ipc.removeListener(process, 'message');
    });

    it('send', (done) => {
        ipc.on(process, 'message', (message: string) => {
            try {
                assert.equal(message, 'ping');
                done();
            } catch(e) {
                done(e)
            }
        });

        ipc.send(process, 'ping');
    });

    it('sendAsync', async () => {
        ipc.on(process, 'message', (message: string) => {
            assert.equal(message, 'ping');
            return 'pong';
        });

        let ackMsg = await ipc.sendAsync(process, 'ping');
        assert.equal(ackMsg, 'pong');
    });
});

describe('child process', () => {
    let child: child_process.ChildProcess;

    afterEach(() => {
        if (child) {
            child.kill();
        }
    });

    it('send', (done) => {
        child = child_process.fork(__dirname + '/child/child');

        ipc.on(child, 'message', (message: string) => {
            try {
                assert.equal(message, 'pong');
                done();
            } catch(e) {
                done(e);
            }
        });

        ipc.send(child, 'ping');
    });

    it('sendAsync', async () => {
        child = child_process.fork(__dirname + '/child/child_async');
        let ackMsg = await ipc.sendAsync(child, 'ping');
        assert.equal(ackMsg, 'pong');
    });

    it('sendAsync with timeout', async () => {
        child = child_process.fork(__dirname + '/child/child_async');
        try {
            let ackMsg = await ipc.sendAsync(child, { delay: 1000 }, { timeout: 500 });
            assert.ifError(ackMsg);
        } catch(e) {
            assert.ok(e instanceof ipc.AckError);
        }
    });

    it('reap', async () => {
        child = child_process.fork(__dirname + '/child/child_async');
        setTimeout(() => { ipc.reap(500); }, 500);
        try {
            let ackMsg = await ipc.sendAsync(child, { delay: 10000 });
            assert.ifError(ackMsg);
        } catch(e) {
            assert.ok(e instanceof ipc.AckError);
        }
    });
});
