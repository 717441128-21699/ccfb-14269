import type { AffineTransform, ClassificationOptions, LabelRaster, RGBImage } from '../core/types';
import { LayerKind } from '../core/types';
import { DEFAULT_CLASSIFICATION } from '../core/types';

/**
 * WebGL2 加速引擎。
 * 职责：
 *  - RGBA 扫描图上传为纹理；
 *  - GPU 片元着色器做颜色分层（与 CPU 参考实现同参数、同标签语义）；
 *  - GPU 仿射重采样（配准对齐）；
 *  - 标签/图层可视化渲染。
 * CPU 实现是正确性基准（vitest 覆盖），GPU 路径在浏览器里负责 2 秒指标。
 */

const QUAD_VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2((a_pos.x + 1.0) * 0.5, (1.0 - a_pos.y) * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const CLASSIFY_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_image;
uniform float u_inkLuma;
uniform float u_colorChroma;
uniform float u_pencilMin;
uniform float u_pencilMax;
// 标签以 RGB 颜色编码输出
vec3 labelColor(float label) {
  if (label < 0.5) return vec3(1.0);            // paper
  if (label < 1.5) return vec3(0.0, 0.0, 0.0);  // ink
  if (label < 2.5) return vec3(1.0, 0.0, 0.0);  // red
  if (label < 3.5) return vec3(0.0, 0.0, 1.0);  // blue
  return vec3(0.2, 0.8, 0.2);                   // peg
}
void main() {
  vec4 s = texture(u_image, v_uv);
  float y = dot(s.rgb, vec3(0.299, 0.587, 0.114)) * 255.0;
  float r = s.r * 255.0;
  float g = s.g * 255.0;
  float b = s.b * 255.0;
  float redness = r - (g + b) * 0.5;
  float blueness = b - (r + g) * 0.5;
  float label = 0.0;
  // 色度优先：明暗像素都先判红蓝彩铅
  if (y >= u_pencilMin && y <= u_pencilMax) {
    if (redness > u_colorChroma && redness > blueness + u_colorChroma) label = 2.0;
    else if (blueness > u_colorChroma && blueness > redness + u_colorChroma) label = 3.0;
  }
  if (label < 0.5 && y < u_inkLuma) {
    if (redness > u_colorChroma && redness > blueness + u_colorChroma) label = 2.0;
    else if (blueness > u_colorChroma && blueness > redness + u_colorChroma) label = 3.0;
    else label = 1.0;
  }
  outColor = vec4(labelColor(label), 1.0);
}`;

const WARP_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_image;
uniform mat3 u_invAffine;
uniform vec2 u_size;
void main() {
  vec3 p = u_invAffine * vec3(v_uv * u_size, 1.0);
  vec2 srcUv = p.xy / u_size;
  if (srcUv.x < 0.0 || srcUv.y < 0.0 || srcUv.x > 1.0 || srcUv.y > 1.0) {
    outColor = vec4(1.0);
  } else {
    outColor = texture(u_image, srcUv);
  }
}`;

const VIEW_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_image;
uniform float u_opacity;
void main() {
  vec4 c = texture(u_image, v_uv);
  outColor = vec4(c.rgb, c.a * u_opacity);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`着色器编译失败: ${log}`);
  }
  return shader;
}

function program(gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vert));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`着色器链接失败: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

export class GLEngine {
  private gl: WebGL2RenderingContext;
  private classifyProg: WebGLProgram;
  private warpProg: WebGLProgram;
  private viewProg: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private framebuffer: WebGLFramebuffer;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.classifyProg = program(gl, QUAD_VERT, CLASSIFY_FRAG);
    this.warpProg = program(gl, QUAD_VERT, WARP_FRAG);
    this.viewProg = program(gl, QUAD_VERT, VIEW_FRAG);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    for (const prog of [this.classifyProg, this.warpProg, this.viewProg]) {
      const loc = gl.getAttribLocation(prog, 'a_pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
    this.framebuffer = gl.createFramebuffer()!;
  }

  static isSupported(): boolean {
    try {
      const c = document.createElement('canvas');
      return !!c.getContext('webgl2');
    } catch {
      return false;
    }
  }

  uploadImage(image: RGBImage): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, image.width, image.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, image.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private renderToTexture(
    prog: WebGLProgram,
    src: WebGLTexture,
    width: number,
    height: number,
    setUniforms: (gl: WebGL2RenderingContext, p: WebGLProgram) => void,
  ): { texture: WebGLTexture; pixels: Uint8Array } {
    const gl = this.gl;
    const out = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, out);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0);
    gl.viewport(0, 0, width, height);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_image'), 0);
    setUniforms(gl, prog);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture: out, pixels };
  }

  /** GPU 颜色分层（第一遍确信分类；压墨恢复仍由 CPU 受限泛洪完成，保证与参考实现一致） */
  classifyGPU(image: RGBImage, options: ClassificationOptions = DEFAULT_CLASSIFICATION): LabelRaster {
    const tex = this.uploadImage(image);
    const { pixels } = this.renderToTexture(this.classifyProg, tex, image.width, image.height, (gl, p) => {
      gl.uniform1f(gl.getUniformLocation(p, 'u_inkLuma'), options.inkLuma);
      gl.uniform1f(gl.getUniformLocation(p, 'u_colorChroma'), options.colorChroma);
      gl.uniform1f(gl.getUniformLocation(p, 'u_pencilMin'), options.pencilLumaMin);
      gl.uniform1f(gl.getUniformLocation(p, 'u_pencilMax'), options.pencilLumaMax);
    });
    this.gl.deleteTexture(tex);
    // readPixels 原点在左下角，需要垂直翻转回图像坐标
    const labels = new Uint8Array(image.width * image.height);
    const w = image.width;
    const h = image.height;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const src = ((h - 1 - y) * w + x) * 4;
        const dst = y * w + x;
        labels[dst] = decodeLabelColor(pixels[src], pixels[src + 1], pixels[src + 2]);
      }
    }
    return { width: w, height: h, labels };
  }

  /** GPU 仿射重采样 */
  warpGPU(image: RGBImage, invAffine: AffineTransform): RGBImage {
    const tex = this.uploadImage(image);
    const m = new Float32Array([
      invAffine.a, invAffine.b, 0,
      invAffine.c, invAffine.d, 0,
      invAffine.e, invAffine.f, 1,
    ]);
    const { pixels } = this.renderToTexture(this.warpProg, tex, image.width, image.height, (gl, p) => {
      gl.uniformMatrix3fv(gl.getUniformLocation(p, 'u_invAffine'), false, m);
      gl.uniform2f(gl.getUniformLocation(p, 'u_size'), image.width, image.height);
    });
    this.gl.deleteTexture(tex);
    // 垂直翻转
    const out = new Uint8Array(pixels.length);
    const rowBytes = image.width * 4;
    for (let y = 0; y < image.height; y++) {
      out.set(pixels.subarray((image.height - 1 - y) * rowBytes, (image.height - y) * rowBytes), y * rowBytes);
    }
    return { width: image.width, height: image.height, data: out };
  }

  /** 把图像直接绘制到画布（图层叠加预览） */
  drawToCanvas(image: RGBImage, opacity = 1): void {
    const gl = this.gl;
    const tex = this.uploadImage(image);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.viewProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(this.viewProg, 'u_image'), 0);
    gl.uniform1f(gl.getUniformLocation(this.viewProg, 'u_opacity'), opacity);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.deleteTexture(tex);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.classifyProg);
    gl.deleteProgram(this.warpProg);
    gl.deleteProgram(this.viewProg);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteVertexArray(this.vao);
  }
}

function decodeLabelColor(r: number, g: number, b: number): LayerKind {
  if (r === 0 && g === 0 && b === 0) return LayerKind.Ink;
  if (r === 255 && g === 0 && b === 0) return LayerKind.RedPencil;
  if (r === 0 && g === 0 && b === 255) return LayerKind.BluePencil;
  if (r === 51 && g === 204 && b === 51) return LayerKind.PegHole;
  return LayerKind.Paper;
}
