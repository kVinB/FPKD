declare const __BUILD_VERSION__: string;

export const BUILD_VERSION: string =
  typeof __BUILD_VERSION__ === 'string' && __BUILD_VERSION__.length > 0
    ? __BUILD_VERSION__
    : 'dev';
