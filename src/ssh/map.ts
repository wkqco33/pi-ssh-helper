import { mapPathPrefix } from 'pi-helper-core';

/**
 * The two roots a session maps between.
 *
 * `localRoot` is the directory pi was started in, `remoteRoot` is the same
 * project on the other side. Keeping both explicit is what lets the core refuse
 * a directory it cannot represent instead of guessing.
 */
export interface PathMapping {
  localRoot: string;
  remoteRoot: string;
}

/** Local working directory → the same directory on the remote host. */
export function toRemotePath(cwd: string, mapping: PathMapping): string {
  return mapPathPrefix(cwd, mapping.localRoot, mapping.remoteRoot);
}

/** Remote path → the same path on this machine (for showing output paths). */
export function toLocalPath(path: string, mapping: PathMapping): string {
  return mapPathPrefix(path, mapping.remoteRoot, mapping.localRoot);
}
