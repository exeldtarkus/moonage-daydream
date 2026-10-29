/** logger untuk modul driver (tanpa akses ke vscode): diisi activate() dengan output channel extension */
export const driverLog: { error(msg: string): void } = { error: () => undefined };
