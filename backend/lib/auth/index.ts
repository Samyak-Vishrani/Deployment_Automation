export const authConfig = {
  secret: process.env.AUTH_SECRET ?? "development-secret",
};

export type AuthEnvironment = {
  secret: string;
};
