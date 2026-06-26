# HammamPOS - Raw Printer Helper
# Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
# Unauthorized copying or distribution is strictly prohibited.

param(
    [Parameter(Mandatory=$true)]
    [string]$PrinterName,
    
    [Parameter(Mandatory=$true)]
    [string]$FilePath
)

Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;

public class RawPrinterHelper
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DOCINFOW
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype;
    }

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFOW pDocInfo);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    public static bool SendRawData(string printerName, byte[] data)
    {
        IntPtr hPrinter = IntPtr.Zero;
        bool success = false;

        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
            throw new Exception("Cannot open printer. Error: " + Marshal.GetLastWin32Error());

        try
        {
            DOCINFOW di = new DOCINFOW();
            di.pDocName = "HammamPOS Ticket";
            di.pDatatype = "RAW";
            di.pOutputFile = null;

            if (!StartDocPrinter(hPrinter, 1, ref di))
                throw new Exception("StartDocPrinter failed. Error: " + Marshal.GetLastWin32Error());

            if (!StartPagePrinter(hPrinter))
                throw new Exception("StartPagePrinter failed. Error: " + Marshal.GetLastWin32Error());

            IntPtr pUnmanagedBytes = Marshal.AllocCoTaskMem(data.Length);
            try
            {
                Marshal.Copy(data, 0, pUnmanagedBytes, data.Length);
                int dwWritten;
                success = WritePrinter(hPrinter, pUnmanagedBytes, data.Length, out dwWritten);
                if (!success)
                    throw new Exception("WritePrinter failed. Error: " + Marshal.GetLastWin32Error());
            }
            finally
            {
                Marshal.FreeCoTaskMem(pUnmanagedBytes);
            }

            EndPagePrinter(hPrinter);
            EndDocPrinter(hPrinter);
        }
        finally
        {
            ClosePrinter(hPrinter);
        }

        return success;
    }
}
"@

$bytes = [System.IO.File]::ReadAllBytes($FilePath)
$result = [RawPrinterHelper]::SendRawData($PrinterName, $bytes)
if ($result) {
    Write-Output "SUCCESS"
} else {
    Write-Error "Print failed"
    exit 1
}
