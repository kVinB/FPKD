import type { DiarySettings } from '@shared/types';
import { api } from './api';

export async function fetchSettings(): Promise<DiarySettings> {
  const data = await api<{ settings: DiarySettings }>('/settings');
  return data.settings;
}

export async function saveReportZone(
  zone: string,
  csrfToken: string,
): Promise<DiarySettings> {
  const data = await api<{ settings: DiarySettings }>('/settings', {
    method: 'PUT',
    body: { reportZone: zone },
    csrfToken,
  });
  return data.settings;
}
