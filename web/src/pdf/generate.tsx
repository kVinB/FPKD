import type { ReportModel } from '@shared/report';

export async function generateReportPdf(model: ReportModel): Promise<Blob> {
  const [{ pdf }, { ReportDocument }] = await Promise.all([
    import('@react-pdf/renderer'),
    import('./ReportDocument'),
  ]);
  return pdf(<ReportDocument model={model} />).toBlob();
}
