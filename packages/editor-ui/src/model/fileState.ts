import type { Diagnostic } from '@forgon/project-schema';

// What the workspace shows about the file on disk. The last valid scene stays visible in every case.
export type FileBanner =
  | { kind: 'invalid'; diagnostics: readonly Diagnostic[] }
  | { kind: 'deleted'; path: string };

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';
