/** Provider shape used by upload VPS provisioning. */
export interface UploadProvider {
  host: string;
  port: number;
  username: string;
  password: string;
  ssl: boolean;
  connections: number;
}
