import { meshIndices, spriteIndices } from './geometry.js';

const VERTEX_SHADER = `#version 300 es
in vec3 aPosition;
in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPosition.xy, 0.0, aPosition.z);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 color;
uniform sampler2D uTexture;
// Felt is a slow gradient, which bands visibly at projector scale. Noise of up to a step either
// way hides that: the art is already 8-bit, so less mostly rounds back to the same value. Black
// stays untouched so unlit areas of the table get no light at all.
float noise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
void main() {
  color = texture(uTexture, vUv);
  float lit = step(0.004, max(color.r, max(color.g, color.b)));
  color.rgb += lit * (noise(gl_FragCoord.xy) - 0.5) * 2.0 / 255.0;
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

function createProgram(gl) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program));
  }
  return program;
}

// One warped grid with its own buffers. The table and the sprite share the vertex format.
function createGrid(gl, program, indices) {
  const vertexArray = gl.createVertexArray();
  const vertexBuffer = gl.createBuffer();
  gl.bindVertexArray(vertexArray);

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  const stride = 5 * Float32Array.BYTES_PER_ELEMENT;
  const position = gl.getAttribLocation(program, 'aPosition');
  const uv = gl.getAttribLocation(program, 'aUv');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(uv);
  gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, stride, 3 * Float32Array.BYTES_PER_ELEMENT);

  return {
    setVertices(vertices) {
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    },
    draw() {
      gl.bindVertexArray(vertexArray);
      gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
    },
  };
}

function createTexture(gl) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Keystone squeezes one side of the table, so filtering has to stay sharp on an angle.
  const anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
  if (anisotropy) {
    const max = gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    gl.texParameterf(gl.TEXTURE_2D, anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
  }
  return texture;
}

function createScene(gl) {
  const program = createProgram(gl);
  gl.useProgram(program);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 1);
  return {
    table: createGrid(gl, program, meshIndices()),
    tableTexture: createTexture(gl),
    sprite: createGrid(gl, program, spriteIndices()),
    spriteTexture: createTexture(gl),
  };
}

function upload(gl, texture, source) {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.generateMipmap(gl.TEXTURE_2D);
}

// `beforeDraw(now)` runs at the top of every frame, so one frame can repaint and move the
// sprite together. `onRestored()` must send everything again: a lost context keeps nothing.
export function createRenderer(canvas, { beforeDraw = () => {}, onRestored = () => {} } = {}) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: true });
  if (!gl) throw new Error('This browser does not support WebGL2.');

  let scene = createScene(gl);
  let hasMesh = false;
  let spriteVisible = false;
  let frame = 0;

  function draw(now) {
    frame = 0;
    if (gl.isContextLost() || !hasMesh) return;
    beforeDraw(now);
    const scale = window.devicePixelRatio || 1;
    const width = Math.round(canvas.clientWidth * scale);
    const height = Math.round(canvas.clientHeight * scale);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D, scene.tableTexture);
    scene.table.draw();
    if (spriteVisible) {
      gl.bindTexture(gl.TEXTURE_2D, scene.spriteTexture);
      scene.sprite.draw();
    }
  }

  const requestDraw = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };

  // Sleeping displays and GPU switches can take the context away. Preventing the default is
  // what asks the browser to give it back.
  canvas.addEventListener('webglcontextlost', (event) => event.preventDefault());
  canvas.addEventListener('webglcontextrestored', () => {
    scene = createScene(gl);
    hasMesh = false;
    spriteVisible = false;
    onRestored();
    requestDraw();
  });

  return {
    setTexture(source) {
      upload(gl, scene.tableTexture, source);
    },
    setMesh(vertices) {
      hasMesh = true;
      scene.table.setVertices(vertices);
    },
    setSpriteTexture(source) {
      upload(gl, scene.spriteTexture, source);
    },
    // Null hides the sprite. Moving it costs only this small buffer, never a texture upload.
    setSpriteMesh(vertices) {
      spriteVisible = vertices !== null;
      if (vertices) scene.sprite.setVertices(vertices);
    },
    requestDraw,
  };
}
