import * as cluster from 'cluster';
import { ChildProcess } from 'child_process';
import * as EventEmitter from 'events';
import * as util from 'util';
import * as net from 'net';

/**
 * Enable ack timeout.
 *
 * @default true
 */
export var enableAckTimeout = true;

/**
 * @default 1 minute
 */
export var ACK_TIMEOUT = 1000 * 60;

export const CMD_SYN = '@jstype/ipc-emitter|syn';
export const CMD_ACK = '@jstype/ipc-emitter|ack';

const SYN_LISTENED = Symbol.for(CMD_SYN);
const ACK_LISTENED = Symbol.for(CMD_ACK);

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export interface IAckError {
    message: string;
    stack?: string;
}

interface SynData {
    _cmd: string;
    _ack?: number;
    _ev: string;
    _msg: any;
}

interface AckData {
    _cmd: string;
    _ack: number;
    _msg?: any;
    _err?: IAckError;
}

interface CallbackInfo {
    resolve: Function;
    reject: Function;
    createdAt: number;
    t?: NodeJS.Timer;
}

interface Events {
    [event: string]: Listener;
}

interface Callbacks {
    [ack: number]: CallbackInfo;
}

export type Listener = (message: any, sendHandle?: net.Socket | net.Server) => any;

export type PS = NodeJS.Process | ChildProcess | cluster.Worker;

export interface Options {
    sendHandle?: net.Socket | net.Server;
    keepOpen?: boolean;
}

export interface AsyncOptions extends Options {
    timeout?: number;
}

var seq = 0;
const callbacks: Callbacks = Object.create(null);
const eventsWeakMap: WeakMap<NodeJS.Process | ChildProcess, Events> = new WeakMap()

export class AckError extends Error implements IAckError {
    message: string;
    stack?: string;

    constructor(err: any) {
        var message: string;
        var stack: string | undefined;

        if (err && err.message) {
            message = err.message;
            stack = err.stack;
        } else if (typeof err == 'string') {
            message = err;
        } else {
            message = util.format('%j', err);
        }

        super(message);
        if (stack) {
            this.stack = stack;
        } else {
            Error.captureStackTrace(this, AckError);
        }
    }

    toJSON() {
        return {
            message: this.message,
            stack: this.stack
        };
    }
}

function onAckProcMessage(data: AckData) {
    if (!data || data._cmd != CMD_ACK) {
        return;
    }

    if (data._ack > 0) {
        var info = callbacks[data._ack];
        if (info) {
            delete callbacks[data._ack];
            clearTimeout(info.t);

            if (data._err) {
                info.reject(new AckError(data._err));
            } else {
                info.resolve(data._msg);
            }
        }
    }
}

function onAckProcRemoveListener(this: EventEmitter, type: string, listener: Function) {
    if (type == 'message' && listener == onAckProcMessage) {
        (<any>this)[ACK_LISTENED] = false;
        this.removeListener('removeListener', onAckProcRemoveListener);
    }
}

function onack(ps: PS) {
    var proc = (<cluster.Worker>ps).process || <NodeJS.Process | ChildProcess>ps;
    if ((<any>proc)[ACK_LISTENED]) {
        return;
    }
    (<any>proc)[ACK_LISTENED] = true;

    (<EventEmitter>proc).on('message', onAckProcMessage);
    (<EventEmitter>proc).on('removeListener', onAckProcRemoveListener);
}

function printIPCChannelClosedWarning(proc: NodeJS.Process | ChildProcess) {
    // just log warnning message
    var err = new Error('channel closed');
    console.warn('[%s][@jstype/ipc-emitter] WARN pid#%s channel closed, nothing send\nstack: %s', Date(), proc.pid, err.stack);

}

function sendSynData(ps: PS, data: SynData, options: Options) {
    if (typeof ps.send != 'function') {
        var send: any;
        if (options.sendHandle) {
            send = ps.emit.bind(ps, 'message', data, options.sendHandle, options);
        } else {
            send = ps.emit.bind(ps, 'message', data)
        }
        setImmediate(send);
        return true;
    }

    var proc = (<cluster.Worker>ps).process || <NodeJS.Process | ChildProcess>ps;
    if (proc.connected) {
        if (options.sendHandle) {
            return (<any>ps).send(data, options.sendHandle, options);
        } else {
            return (<any>ps).send(data);
        }
    }

    printIPCChannelClosedWarning(proc);
    return false;
}

function onAckTimeout(ack: number) {
    var info = callbacks[ack];
    if (info) {
        delete callbacks[ack];
        info.reject(new AckError('@jstype/ipc-emitter ack timeout'));
    }
}

function _emitAsync(event: string, ps: PS, message: any, options?: AsyncOptions) {
    options = options || {};
    return new Promise(function (resolve, reject) {
        seq = seq % MAX_SAFE_INTEGER + 1;
        var ack = seq;
        var info: CallbackInfo = {
            resolve,
            reject,
            createdAt: Date.now()
        };
        if (enableAckTimeout) {
            if (options.timeout == undefined) {
                if (ACK_TIMEOUT > 0) {
                    info.t = setTimeout(onAckTimeout, ACK_TIMEOUT, ack);
                }
            } else if (options.timeout > 0) {
                info.t = setTimeout(onAckTimeout, options.timeout, ack);
            }
        }
        callbacks[ack] = info;

        var data: SynData = {
            _cmd: CMD_SYN,
            _ack: ack,
            _ev: event,
            _msg: message
        };

        sendSynData(ps, data, options);
    });
}

export function send(ps: PS, message: any, options?: Options) {
    return emit(ps, 'message', message, options);
}

export function emit(ps: PS, event: string, message: any, options?: Options) {
    options = options || {};

    var data: SynData = {
        _cmd: CMD_SYN,
        _ev: event,
        _msg: message
    };

    return sendSynData(ps, data, options);
}

export function sendAsync(ps: PS, message: any, options?: AsyncOptions): Promise<any> {
    return emitAsync(ps, 'message', message, options);
}

export function emitAsync(ps: PS, event: string, message: any, options?: AsyncOptions) {
    onack(ps);
    return _emitAsync(event, ps, message, options);
}

function onsyn(ps: PS) {
    var proc = (<cluster.Worker>ps).process || <NodeJS.Process | ChildProcess>ps;
    if ((<any>proc)[SYN_LISTENED]) {
        return;
    }
    (<any>proc)[SYN_LISTENED] = true;

    var send: (message: any) => void;
    if (typeof proc.send == 'function') {
        send = function send(message: any) {
            if (proc.connected) {
                proc.send(message);
                return;
            }

            printIPCChannelClosedWarning(proc);
        }
    } else {
        send = proc.emit.bind(proc, 'message');
    }

    var events = <Events>eventsWeakMap.get(proc);
    if (!events) {
        events = Object.create(null);
        eventsWeakMap.set(proc, events);
    }

    function onSynProcMessage(data: SynData, sendHandle: net.Socket | net.Server) {
        if (!data || data._cmd != CMD_SYN) {
            return;
        }

        var handler = events[data._ev];

        if (<number>data._ack > 0) {
            var ackData: AckData = {
                _cmd: CMD_ACK,
                _ack: <number>data._ack
            };
            var ackPromise: Promise<any>;
            try {
                ackPromise = Promise.resolve(handler.call(proc, data._msg, sendHandle));
            } catch (e) {
                ackData._err = new AckError(e);
                send(ackData);
                return;
            }

            ackPromise.then(function (msg: any) {
                ackData._msg = msg;
                send(ackData);
            }, function (reason: any) {
                ackData._err = new AckError(reason);
                send(ackData);
            });

        } else {
            try {
                handler.call(process, data._msg, sendHandle);
            } catch (e) {
                var format = '[%s][@jstype/ipc-emitter] WARN pid#%s uncaught Exception in non-ack event listener\n';
                var msgOrStack: any;
                if (e instanceof Error) {
                    format += 'stack: %s';
                    msgOrStack = e.stack;
                } else if (typeof e == 'string') {
                    format += 'error message: %s';
                    msgOrStack = e;
                } else {
                    format += 'error data: %j'
                    msgOrStack = e;
                }
                console.warn(format, Date(), proc.pid, msgOrStack);
            }
        }
    }

    function onSynProcRemoveListener(this: EventEmitter, type: string, listener: Function) {
        if (type == 'message' && listener == onSynProcMessage) {
            (<any>this)[SYN_LISTENED] = false;
            this.removeListener('removeListener', onSynProcRemoveListener);
        }
    }

    (<EventEmitter>proc).on('message', onSynProcMessage);
    (<EventEmitter>proc).on('removeListener', onSynProcRemoveListener);
}

function _addListener(ps: PS, event: string, listener: Listener) {
    if (typeof listener != 'function') {
        throw new TypeError('"listener" argument must be a function');
    }

    var proc = (<cluster.Worker>ps).process || <NodeJS.Process | ChildProcess>ps;
    var events = <Events>eventsWeakMap.get(proc);

    if (events[event]) {
        throw new Error('event "' + event + '" already add a listener');
    }

    events[event] = listener;
}

export function addListener(ps: PS, event: string, listener: Listener) {
    onsyn(ps);
    return _addListener(ps, event, listener);
}

export function on(ps: PS, event: string, listener: Listener) {
    return addListener(ps, event, listener);
}

export function once(ps: PS, event: string, listener: Listener) {
    if (typeof listener != 'function') {
        throw new TypeError('"listener" argument must be a function');
    }

    var fired = false;
    on(ps, event, function (this: any, message: any) {
        removeListener(ps, event);
        if (fired) {
            throw new Error('event " + event + " should been fired once');
        }
        return listener.call(this, message);
    });
}

export function removeListener(ps: PS, event: string) {
    var proc = (<cluster.Worker>ps).process || <NodeJS.Process | ChildProcess>ps
    var events = eventsWeakMap.get(proc);
    if (events) {
        delete events[event];
    }
}

export function reap(timeout: number) {
    var now = Date.now();
    var acks = Object.keys(callbacks);

    var i: number,
        len: number,
        ack: number,
        info: CallbackInfo;

    for (i = 0, len = acks.length; i < len; i++) {
        ack = <any>acks[i];
        info = callbacks[ack];

        if (info) {
            if (now - info.createdAt < timeout) {
                continue;
            }

            delete callbacks[ack];
            clearTimeout(info.t);
            info.reject(new AckError('@jstype/ipc-emitter ack timeout'));
        }
    }
}
