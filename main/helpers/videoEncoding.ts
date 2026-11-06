/** Portable H.264 output for desktop, mobile and hardware video decoders. */
export const COMPATIBLE_PIXEL_FORMAT = 'yuv420p';

/** Preserve compose's existing right/bottom one-pixel crop policy. */
export const EVEN_DIMENSIONS_CROP_FILTER =
  'crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0';

/** Keep every source pixel when normalizing toolbox videos for 4:2:0 encoding. */
export const EVEN_DIMENSIONS_PAD_FILTER = 'pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0';
