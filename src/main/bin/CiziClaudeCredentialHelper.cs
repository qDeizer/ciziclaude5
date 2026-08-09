using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class CiziClaudeCredentialHelper
{
    private const int AttemptCount = 3;
    private const int AttemptTimeoutMilliseconds = 10000;
    private const string TargetFileName = "cizicode-credential-target.txt";
    private const string TargetPrefix = "CiziCode-Claude/GatewayCredential/";
    private const uint CredTypeGeneric = 1;
    private const uint CredPersistLocalMachine = 2;
    private const int ErrorNotFound = 1168;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NativeCredential
    {
        internal uint Flags;
        internal uint Type;
        internal IntPtr TargetName;
        internal IntPtr Comment;
        internal System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        internal uint CredentialBlobSize;
        internal IntPtr CredentialBlob;
        internal uint Persist;
        internal uint AttributeCount;
        internal IntPtr Attributes;
        internal IntPtr TargetAlias;
        internal IntPtr UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredWrite(ref NativeCredential credential, uint flags);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr credential);

    private static int Main(string[] arguments)
    {
        try
        {
            string explicitTarget = Argument(arguments, "--target");
            if (HasArgument(arguments, "--store-stdin"))
            {
                string secret = Console.In.ReadToEnd();
                try
                {
                    ValidateSecret(secret);
                    WriteCredential(ValidateTarget(explicitTarget), secret);
                    return 0;
                }
                finally
                {
                    secret = null;
                }
            }
            if (HasArgument(arguments, "--delete"))
            {
                DeleteCredential(ValidateTarget(explicitTarget));
                return 0;
            }

            string baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
            string hostFile = Path.Combine(baseDirectory, "cizicode-host.txt");
            if (File.Exists(hostFile))
            {
                // Claude Code still uses the historical windowless Electron
                // credential host. Claude Desktop deliberately does not.
                return RunConfiguredHost(hostFile);
            }

            string target;
            if (!String.IsNullOrWhiteSpace(explicitTarget))
            {
                target = ValidateTarget(explicitTarget);
            }
            else
            {
                string targetFile = Path.Combine(baseDirectory, TargetFileName);
                if (!File.Exists(targetFile))
                {
                    Console.Error.WriteLine("Cizi Code credential target is missing.");
                    return 2;
                }
                target = ValidateTarget(File.ReadAllText(targetFile).Trim());
            }
            string credential = ReadCredential(target);
            try
            {
                if (String.IsNullOrWhiteSpace(credential)) return 3;
                Console.Out.Write(credential);
                return 0;
            }
            finally
            {
                credential = null;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    private static bool HasArgument(string[] arguments, string expected)
    {
        foreach (string argument in arguments)
        {
            if (String.Equals(argument, expected, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static string Argument(string[] arguments, string name)
    {
        string prefix = name + "=";
        foreach (string argument in arguments)
        {
            if (argument != null && argument.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                return argument.Substring(prefix.Length);
        }
        return null;
    }

    private static string ValidateTarget(string value)
    {
        if (String.IsNullOrWhiteSpace(value) ||
            !value.StartsWith(TargetPrefix, StringComparison.Ordinal) ||
            value.Length != TargetPrefix.Length + 32)
        {
            throw new InvalidDataException("Cizi Code credential target is invalid.");
        }
        Guid parsed;
        if (!Guid.TryParseExact(value.Substring(TargetPrefix.Length), "N", out parsed))
            throw new InvalidDataException("Cizi Code credential target is invalid.");
        return value;
    }

    private static void ValidateSecret(string secret)
    {
        if (String.IsNullOrWhiteSpace(secret) || secret.Length > 4096 ||
            !String.Equals(secret, secret.Trim(), StringComparison.Ordinal))
            throw new InvalidDataException("Cizi Code credential is invalid.");
        foreach (char character in secret)
        {
            if (Char.IsControl(character))
                throw new InvalidDataException("Cizi Code credential is invalid.");
        }
    }

    private static void WriteCredential(string target, string secret)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(secret);
        IntPtr targetPointer = IntPtr.Zero;
        IntPtr userPointer = IntPtr.Zero;
        IntPtr blobPointer = IntPtr.Zero;
        try
        {
            targetPointer = Marshal.StringToCoTaskMemUni(target);
            userPointer = Marshal.StringToCoTaskMemUni(Environment.UserName);
            blobPointer = Marshal.AllocCoTaskMem(bytes.Length);
            Marshal.Copy(bytes, 0, blobPointer, bytes.Length);
            NativeCredential credential = new NativeCredential
            {
                Type = CredTypeGeneric,
                TargetName = targetPointer,
                CredentialBlobSize = (uint)bytes.Length,
                CredentialBlob = blobPointer,
                Persist = CredPersistLocalMachine,
                UserName = userPointer
            };
            if (!CredWrite(ref credential, 0))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows Credential Manager rejected the Cizi Code credential.");
        }
        finally
        {
            Array.Clear(bytes, 0, bytes.Length);
            if (blobPointer != IntPtr.Zero)
            {
                byte[] zero = new byte[Math.Max(1, bytes.Length)];
                Marshal.Copy(zero, 0, blobPointer, bytes.Length);
                Marshal.FreeCoTaskMem(blobPointer);
            }
            if (userPointer != IntPtr.Zero) Marshal.ZeroFreeCoTaskMemUnicode(userPointer);
            if (targetPointer != IntPtr.Zero) Marshal.ZeroFreeCoTaskMemUnicode(targetPointer);
        }
    }

    private static string ReadCredential(string target)
    {
        IntPtr credentialPointer;
        if (!CredRead(target, CredTypeGeneric, 0, out credentialPointer))
        {
            int error = Marshal.GetLastWin32Error();
            if (error == ErrorNotFound) return null;
            throw new Win32Exception(error, "Windows Credential Manager could not read the Cizi Code credential.");
        }
        try
        {
            NativeCredential credential = (NativeCredential)Marshal.PtrToStructure(
                credentialPointer,
                typeof(NativeCredential));
            if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0) return null;
            byte[] bytes = new byte[credential.CredentialBlobSize];
            try
            {
                Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
                return Encoding.UTF8.GetString(bytes);
            }
            finally
            {
                Array.Clear(bytes, 0, bytes.Length);
            }
        }
        finally
        {
            CredFree(credentialPointer);
        }
    }

    private static void DeleteCredential(string target)
    {
        if (!CredDelete(target, CredTypeGeneric, 0))
        {
            int error = Marshal.GetLastWin32Error();
            if (error != ErrorNotFound)
                throw new Win32Exception(error, "Windows Credential Manager could not remove the Cizi Code credential.");
        }
    }

    private static int RunConfiguredHost(string hostFile)
    {
        string[] hostLines = File.ReadAllLines(hostFile);
        string hostExecutable;
        string workingDirectory;
        var hostArguments = new List<string>();
        if (hostLines.Length >= 4 && hostLines[0] == "CIZI_HOST_V2")
        {
            hostExecutable = Decode(hostLines[1]);
            workingDirectory = Decode(hostLines[2]);
            for (int index = 3; index < hostLines.Length; index++)
            {
                if (hostLines[index].Length > 0) hostArguments.Add(Decode(hostLines[index]));
            }
        }
        else
        {
            hostExecutable = File.ReadAllText(hostFile).Trim();
            workingDirectory = Path.GetDirectoryName(hostExecutable);
            hostArguments.Add("--cizi-claude-credential-helper");
        }
        if (hostExecutable.Length == 0 || !File.Exists(hostExecutable)) return 3;

        for (int attempt = 1; attempt <= AttemptCount; attempt++)
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = hostExecutable,
                Arguments = JoinArguments(hostArguments),
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            using (Process process = Process.Start(startInfo))
            {
                if (process == null) return 4;
                var output = new StringBuilder();
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
                {
                    if (eventArgs.Data != null) output.Append(eventArgs.Data);
                };
                process.BeginOutputReadLine();
                if (!process.WaitForExit(AttemptTimeoutMilliseconds))
                {
                    try { process.Kill(); } catch { }
                    if (attempt == AttemptCount) return 5;
                }
                else
                {
                    process.WaitForExit();
                    string token = output.ToString().Trim();
                    if (process.ExitCode == 0 && token.Length > 0)
                    {
                        Console.Out.Write(token);
                        return 0;
                    }
                }
            }
            if (attempt < AttemptCount) System.Threading.Thread.Sleep(250 * attempt);
        }
        return 6;
    }

    private static string Decode(string value)
    {
        return Encoding.UTF8.GetString(Convert.FromBase64String(value));
    }

    private static string QuoteArgument(string value)
    {
        if (value.IndexOf('\"') >= 0) throw new InvalidDataException("Cizi Code host argument is invalid.");
        return "\"" + value + "\"";
    }

    private static string JoinArguments(List<string> arguments)
    {
        var encoded = new List<string>();
        foreach (string argument in arguments) encoded.Add(QuoteArgument(argument));
        return string.Join(" ", encoded.ToArray());
    }
}
