export function getApiBaseUrl(): string {
  const value = process.env.NEXT_PUBLIC_API_URL?.trim();

  if (!value) {
    throw new Error(
      "Missing NEXT_PUBLIC_API_URL. Set it to http://localhost:3001 in the frontend environment.",
    );
  }

  return value.replace(/\/+$/, "");
}
