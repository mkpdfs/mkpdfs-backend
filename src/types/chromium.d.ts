// Type declarations for @sparticuz/chromium Lambda layer
declare module '@sparticuz/chromium' {
  const chromium: {
    args: string[];
    executablePath: () => Promise<string>;
    headless: boolean | 'shell';
  };
  export default chromium;
}
