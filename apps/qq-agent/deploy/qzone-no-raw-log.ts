/** Local build replacement: upstream raw HTTP response dumps are never persisted. */
export function dumpRawResponse(..._args: unknown[]): void {}
export function withRawDump<A extends unknown[],R>(_label:string,fn:(...args:A)=>Promise<R>):(...args:A)=>Promise<R> {return fn}
