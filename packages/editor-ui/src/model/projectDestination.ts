// The host still checks containment and refuses existing destinations.
export function projectDestination(parent: string, name: string): string {
  if (!parent.trim()) throw new Error('Choose a parent folder.');
  if (!name || name !== name.trim() || name.length > 80 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error('Enter a folder name of 1-80 characters without reserved Windows names, slashes, or trailing dots/spaces.');
  }
  const separator = parent.includes('\\') ? '\\' : '/';
  return `${parent.replace(/[\\/]+$/, '')}${separator}${name}`;
}
