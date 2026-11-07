// Convert the approved PNG into native Windows icon resources. No generative
// drawing or retouching here: only high-quality scaling and format encoding.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

class NativeIconBuilder {
  static Bitmap Scale(Image source, int size) {
    var bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb);
    using (var graphics = Graphics.FromImage(bitmap)) {
      graphics.Clear(Color.Transparent);
      graphics.CompositingMode = CompositingMode.SourceCopy;
      graphics.CompositingQuality = CompositingQuality.HighQuality;
      graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
      graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
      graphics.DrawImage(source, new Rectangle(0, 0, size, size));
    }
    return bitmap;
  }
  static byte[] Encode(Bitmap bitmap) {
    int size = bitmap.Width;
    using (var data = new MemoryStream()) using (var writer = new BinaryWriter(data)) {
      if (size == 256) { bitmap.Save(data, ImageFormat.Png); return data.ToArray(); }
      var locked = bitmap.LockBits(new Rectangle(0,0,size,size), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      var row = new byte[size*4]; int maskStride = ((size+31)/32)*4; var mask = new byte[maskStride*size];
      try {
        writer.Write(40); writer.Write(size); writer.Write(size*2); writer.Write((ushort)1); writer.Write((ushort)32);
        writer.Write(0); writer.Write(size*size*4+mask.Length); writer.Write(0); writer.Write(0); writer.Write(0); writer.Write(0);
        for(int y=size-1;y>=0;y--) {
          Marshal.Copy(IntPtr.Add(locked.Scan0,y*locked.Stride),row,0,row.Length); writer.Write(row);
          for(int x=0;x<size;x++) if(row[x*4+3]==0) mask[(size-1-y)*maskStride+x/8] |= (byte)(0x80>>(x%8));
        }
        writer.Write(mask); return data.ToArray();
      } finally { bitmap.UnlockBits(locked); }
    }
  }
  static void Main(string[] args) {
    var sizes = new[]{16,20,24,32,40,48,64,128,256}; var frames = new List<byte[]>();
    using (var source = Image.FromFile(args[0])) {
      foreach(int size in sizes) using(var bitmap=Scale(source,size)) frames.Add(Encode(bitmap));
      using(var preview=Scale(source,256)) preview.Save(args[2],ImageFormat.Png);
      if(args.Length > 4) {
        Directory.CreateDirectory(args[4]);
        foreach(int size in new[]{32,180,512}) using(var bitmap=Scale(source,size)) bitmap.Save(Path.Combine(args[4],size+".png"),ImageFormat.Png);
      }
      using(var sheet = new Bitmap(650,180)) using(var graphics=Graphics.FromImage(sheet)) {
        graphics.Clear(ColorTranslator.FromHtml("#faf9f6")); int x=20;
        foreach(int size in new[]{16,24,32,48,64,128}) using(var bitmap=Scale(source,size)) {
          graphics.DrawImageUnscaled(bitmap,x,20); graphics.DrawString(size+" px",SystemFonts.CaptionFont,Brushes.DimGray,x,152); x+=size+32;
        }
        sheet.Save(args[3],ImageFormat.Png);
      }
    }
    using(var writer=new BinaryWriter(File.Create(args[1]))) {
      writer.Write((ushort)0); writer.Write((ushort)1); writer.Write((ushort)sizes.Length); int offset=6+16*sizes.Length;
      for(int i=0;i<sizes.Length;i++) {
        writer.Write((byte)(sizes[i]==256?0:sizes[i])); writer.Write((byte)(sizes[i]==256?0:sizes[i])); writer.Write((byte)0); writer.Write((byte)0);
        writer.Write((ushort)1); writer.Write((ushort)32); writer.Write(frames[i].Length); writer.Write(offset); offset+=frames[i].Length;
      }
      foreach(var frame in frames) writer.Write(frame);
    }
    Console.WriteLine("Encoded Windows ICO: 16,20,24,32,40,48,64,128,256 pixels");
  }
}
