import { call } from "./ipc";

/** A URL DuckDB can read (httpfs): `http(s)://` or `s3://`. */
export const isUrl = (path: string) => /^(https?|s3):\/\//i.test(path);

/** The last part of a URL's path, e.g. `sales.csv.gz`. */
export function urlName(url: string): string {
  const path = url.split(/[?#]/)[0]!.replace(/\/+$/, "");
  return path.split("/").pop() || url;
}

/** S3-compatible storage settings; mirrors `S3Settings` in src-tauri/src/remote. */
export interface S3Settings {
  keyId: string;
  /** Empty when saving keeps the stored secret. */
  secret: string;
  region?: string | null;
  endpoint?: string | null;
  /** "path" for most self-hosted services, "vhost" for AWS. */
  urlStyle?: string | null;
  useSsl?: boolean | null;
}

/** What is stored in the keychain, without the secret. */
export type S3Summary = Omit<S3Settings, "secret">;

export function getS3Settings(): Promise<S3Summary | null> {
  return call("get_s3_settings");
}

export function saveS3Settings(settings: S3Settings): Promise<void> {
  return call("save_s3_settings", { settings });
}

export function clearS3Settings(): Promise<void> {
  return call("clear_s3_settings");
}
