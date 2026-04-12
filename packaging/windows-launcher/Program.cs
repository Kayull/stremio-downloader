using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;

namespace StremioDownloader.WindowsLauncher;

internal static class Program
{
    private const string MainExecutableName = "Stremio Downloader.exe";
    private const string TrailerMarker = "STREMIO_DOWNLOADER_PAYLOAD_V1";

    [STAThread]
    private static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        try
        {
            string launcherPath = Environment.ProcessPath
                ?? throw new InvalidOperationException("Could not resolve the launcher executable path.");
            string extractionRoot = PreparePayload(launcherPath);
            string appPath = Path.Combine(extractionRoot, MainExecutableName);

            if (!File.Exists(appPath))
            {
                throw new FileNotFoundException(
                    $"The extracted application executable was not found: {appPath}",
                    appPath
                );
            }

            using Process process = StartApplication(appPath, extractionRoot, args);
            return 0;
        }
        catch (Exception err)
        {
            MessageBox.Show(
                err.Message,
                "Stremio Downloader",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return 1;
        }
    }

    private static Process StartApplication(string appPath, string workingDirectory, string[] args)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = appPath,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false
        };

        foreach (string arg in args)
        {
            startInfo.ArgumentList.Add(arg);
        }

        return Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start the extracted application.");
    }

    private static string PreparePayload(string launcherPath)
    {
        string launcherHash = ComputeLauncherHash(launcherPath);
        string rootDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Stremio Downloader Portable",
            launcherHash
        );
        string appDir = Path.Combine(rootDir, "app");
        string markerPath = Path.Combine(rootDir, ".complete");

        using var mutex = new Mutex(false, "Local\\StremioDownloaderPortable_" + launcherHash);
        mutex.WaitOne();

        try
        {
            if (File.Exists(markerPath) && File.Exists(Path.Combine(appDir, MainExecutableName)))
            {
                return appDir;
            }

            string tempDir = Path.Combine(rootDir, "app.tmp-" + Guid.NewGuid().ToString("N"));
            if (Directory.Exists(tempDir))
            {
                Directory.Delete(tempDir, true);
            }

            Directory.CreateDirectory(rootDir);
            ExtractPayloadZip(launcherPath, tempDir);

            if (Directory.Exists(appDir))
            {
                Directory.Delete(appDir, true);
            }

            Directory.Move(tempDir, appDir);
            File.WriteAllText(markerPath, launcherHash, Encoding.UTF8);

            return appDir;
        }
        finally
        {
            mutex.ReleaseMutex();
        }
    }

    private static void ExtractPayloadZip(string launcherPath, string destinationDir)
    {
        Directory.CreateDirectory(destinationDir);

        using FileStream launcherStream = new(
            launcherPath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read
        );

        PayloadLocation payload = ReadPayloadLocation(launcherStream);
        launcherStream.Position = payload.Offset;

        using var payloadStream = new Substream(launcherStream, payload.Offset, payload.Length);
        using var archive = new ZipArchive(payloadStream, ZipArchiveMode.Read, leaveOpen: false);

        foreach (ZipArchiveEntry entry in archive.Entries)
        {
            string entryName = entry.FullName.Replace('\\', '/');
            if (string.IsNullOrWhiteSpace(entryName))
            {
                continue;
            }

            string destinationPath = Path.GetFullPath(Path.Combine(destinationDir, entryName));
            string destinationRoot = Path.GetFullPath(destinationDir + Path.DirectorySeparatorChar);
            if (!destinationPath.StartsWith(destinationRoot, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("The bundled payload contains an invalid path.");
            }

            if (entryName.EndsWith("/", StringComparison.Ordinal))
            {
                Directory.CreateDirectory(destinationPath);
                continue;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);
            using Stream entryStream = entry.Open();
            using FileStream output = new(destinationPath, FileMode.Create, FileAccess.Write, FileShare.None);
            entryStream.CopyTo(output);
        }
    }

    private static PayloadLocation ReadPayloadLocation(FileStream launcherStream)
    {
        byte[] markerBytes = Encoding.ASCII.GetBytes(TrailerMarker);
        int trailerLength = sizeof(long) + markerBytes.Length;
        if (launcherStream.Length <= trailerLength)
        {
            throw new InvalidOperationException("The launcher does not contain an embedded payload.");
        }

        launcherStream.Position = launcherStream.Length - trailerLength;
        byte[] payloadLengthBytes = ReadExactly(launcherStream, sizeof(long));
        byte[] markerBuffer = ReadExactly(launcherStream, markerBytes.Length);

        if (!markerBuffer.AsSpan().SequenceEqual(markerBytes))
        {
            throw new InvalidOperationException("The launcher payload trailer is invalid.");
        }

        long payloadLength = BinaryPrimitives.ReadInt64LittleEndian(payloadLengthBytes);
        long payloadOffset = launcherStream.Length - trailerLength - payloadLength;
        if (payloadLength <= 0 || payloadOffset < 0)
        {
            throw new InvalidOperationException("The launcher payload size is invalid.");
        }

        return new PayloadLocation(payloadOffset, payloadLength);
    }

    private static byte[] ReadExactly(Stream stream, int length)
    {
        byte[] buffer = new byte[length];
        int offset = 0;

        while (offset < length)
        {
            int bytesRead = stream.Read(buffer, offset, length - offset);
            if (bytesRead <= 0)
            {
                throw new EndOfStreamException("Unexpected end of launcher payload.");
            }

            offset += bytesRead;
        }

        return buffer;
    }

    private static string ComputeLauncherHash(string launcherPath)
    {
        using var stream = File.OpenRead(launcherPath);
        byte[] hash = SHA256.HashData(stream);
        return Convert.ToHexString(hash).Substring(0, 16);
    }

    private sealed record PayloadLocation(long Offset, long Length);

    private sealed class Substream : Stream
    {
        private readonly Stream _inner;
        private readonly long _start;
        private readonly long _length;
        private long _position;

        public Substream(Stream inner, long start, long length)
        {
            _inner = inner;
            _start = start;
            _length = length;
            _position = 0;
        }

        public override bool CanRead => true;
        public override bool CanSeek => true;
        public override bool CanWrite => false;
        public override long Length => _length;

        public override long Position
        {
            get => _position;
            set
            {
                if (value < 0 || value > _length)
                {
                    throw new ArgumentOutOfRangeException(nameof(value));
                }

                _position = value;
            }
        }

        public override void Flush()
        {
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (_position >= _length)
            {
                return 0;
            }

            long remaining = _length - _position;
            int bytesToRead = (int)Math.Min(count, remaining);
            _inner.Position = _start + _position;
            int bytesRead = _inner.Read(buffer, offset, bytesToRead);
            _position += bytesRead;
            return bytesRead;
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            long nextPosition = origin switch
            {
                SeekOrigin.Begin => offset,
                SeekOrigin.Current => _position + offset,
                SeekOrigin.End => _length + offset,
                _ => throw new ArgumentOutOfRangeException(nameof(origin))
            };

            if (nextPosition < 0 || nextPosition > _length)
            {
                throw new IOException("Seek would move outside the payload stream.");
            }

            _position = nextPosition;
            return _position;
        }

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
