import { parseScene } from '@forgon/project-schema';
import type { SceneDocument, ValidationContext } from '@forgon/project-schema';

/**
 * Validates an untrusted scene input through the shared schema before any runtime
 * state is touched. Structural validation always runs; reference validation runs
 * when the caller supplies catalogs. Invalid input throws DocumentValidationError,
 * and the runtime retains whatever it rendered before.
 */
export function validateScene(input: unknown, context?: ValidationContext): SceneDocument {
  return context ? parseScene(input, context) : parseScene(input);
}

export function faultMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'DocumentValidationError') {
      const lines = (error as { diagnostics?: { path: string; message: string }[] }).diagnostics ?? [];
      const detail = lines.slice(0, 3).map(item => `${item.path}: ${item.message}`).join('; ');
      return `Scene rejected by validation: ${detail || error.message}`;
    }
    return error.message;
  }
  return String(error);
}
