import * as ipc from '../../';

ipc.on(process, 'message', (message: string) => {
    ipc.send(process, 'pong');
});