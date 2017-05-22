import * as ipc from '../../';

ipc.on(process, 'message', (message: any) => {
    if (typeof message == 'string') {
        return 'pong';
    } else if (message.delay > 0) {
        return new Promise((resolve, reject) => {
            setTimeout(resolve, message.delay);
        });
    }
});