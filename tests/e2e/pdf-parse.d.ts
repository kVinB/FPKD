declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    text: string;
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
  }
  function pdf(data: Buffer): Promise<PdfParseResult>;
  export default pdf;
}
