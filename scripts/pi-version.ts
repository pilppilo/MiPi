// SemVer with optional prerelease and build metadata. Numeric prerelease identifiers have no leading zeroes.
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const PI_DURABLE_PACKAGE = "@earendil-works/pi-durable";

export const isPiVersion = (value: string): boolean => SEMVER.test(value);
