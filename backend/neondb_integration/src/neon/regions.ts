/**
 * Regions and Postgres versions a new Neon project can be created with. Both
 * are fixed once the project exists.
 */

export const REGIONS = [
  { id: "aws-us-east-1", label: "AWS US East (N. Virginia)" },
  { id: "aws-us-east-2", label: "AWS US East (Ohio)" },
  { id: "aws-us-west-2", label: "AWS US West (Oregon)" },
  { id: "aws-eu-central-1", label: "AWS Europe (Frankfurt)" },
  { id: "aws-eu-west-2", label: "AWS Europe (London)" },
  { id: "aws-ap-southeast-1", label: "AWS Asia Pacific (Singapore)" },
  { id: "aws-ap-southeast-2", label: "AWS Asia Pacific (Sydney)" },
  { id: "aws-sa-east-1", label: "AWS South America (São Paulo)" },
  { id: "azure-eastus2", label: "Azure East US 2 (Virginia)" },
  { id: "azure-westus3", label: "Azure West US 3 (Arizona)" },
  { id: "azure-gwc", label: "Azure Germany West Central (Frankfurt)" },
] as const;

export type RegionId = (typeof REGIONS)[number]["id"];

export const REGION_IDS: readonly string[] = REGIONS.map((r) => r.id);

/** Oregon: next to Render's default region, so the backend's queries stay short. */
export const DEFAULT_REGION: RegionId = "aws-us-west-2";

export const PG_VERSIONS = [15, 16, 17] as const;

export const DEFAULT_PG_VERSION = 17;

export const isRegionId = (value: unknown): value is RegionId =>
  typeof value === "string" && REGION_IDS.includes(value);

export const isPgVersion = (value: unknown): value is (typeof PG_VERSIONS)[number] =>
  typeof value === "number" && (PG_VERSIONS as readonly number[]).includes(value);
