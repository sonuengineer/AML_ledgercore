import { apiGet, apiPost } from '@/lib/api';
import type { LoginResponse, MeResponse } from '@/types/api';

export const login = (staffCode: string, password: string): Promise<LoginResponse> =>
  apiPost<LoginResponse>('/auth/login', { staffCode, password });

export const fetchMe = (): Promise<MeResponse> => apiGet<MeResponse>('/auth/me');
