const rawUrl = import.meta.env.VITE_API_BASE_URL || "http://localhost:5001";
export const API_BASE_URL = rawUrl.replace(/\/+$/, "");