import * as THREE from 'three';

export class GSViewer {
  public mesh: THREE.Mesh;
  constructor(data: any) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.instanceCount = data.positions.length / 3;
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1.5,-1.5,0, 1.5,-1.5,0, 1.5,1.5,0, -1.5,1.5,0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    
    geometry.setAttribute('splatPos', new THREE.InstancedBufferAttribute(data.positions, 3));
    geometry.setAttribute('splatColor', new THREE.InstancedBufferAttribute(data.colors, 3));
    geometry.setAttribute('splatOpacity', new THREE.InstancedBufferAttribute(data.opacities, 1));
    geometry.setAttribute('splatScale', new THREE.InstancedBufferAttribute(data.scales, 3));
    geometry.setAttribute('splatRot', new THREE.InstancedBufferAttribute(data.rots, 4));
    geometry.setAttribute('boneIndex', new THREE.InstancedBufferAttribute(data.boneIndices, 4));
    geometry.setAttribute('boneWeight', new THREE.InstancedBufferAttribute(data.boneWeights, 4));

    const material = new THREE.ShaderMaterial({
      uniforms: { jawOpen: { value: 0.0 }, boneMatrices: { value: null } },
      vertexShader: `
        precision highp float;
        attribute vec3 splatPos; attribute vec3 splatColor; attribute float splatOpacity;
        attribute vec3 splatScale; attribute vec4 splatRot;
        attribute vec4 boneIndex; attribute vec4 boneWeight;
        uniform sampler2D boneMatrices; uniform float jawOpen;
        varying vec3 vColor; varying float vAlpha; varying vec2 vPosition;

        mat4 getBoneMatrix(float i) {
          float v = (floor(i) + 0.5) / 64.0;
          return mat4(texture2D(boneMatrices, vec2(0.125, v)), texture2D(boneMatrices, vec2(0.375, v)), texture2D(boneMatrices, vec2(0.625, v)), texture2D(boneMatrices, vec2(0.875, v)));
        }

        void main() {
          // LBS計算 (GUAVA仕様 24属性)
          mat4 skinMat = getBoneMatrix(boneIndex.x) * boneWeight.x + getBoneMatrix(boneIndex.y) * boneWeight.y;
          if (skinMat[3][3] < 0.1) skinMat = mat4(1.0);

          vec3 p = splatPos;
          if (p.y > 0.2 && p.y < 0.4 && p.z > 0.05) p.y -= jawOpen * 0.06;

          vec4 worldPos = modelMatrix * skinMat * vec4(p, 1.0);
          
          vec4 q = normalize(splatRot);
          mat3 rotMat = mat3(
            1.0 - 2.0 * (q.y*q.y + q.z*q.z), 2.0 * (q.x*q.y - q.z*q.w), 2.0 * (q.x*q.z + q.y*q.w),
            2.0 * (q.x*q.y + q.z*q.w), 1.0 - 2.0 * (q.x*q.x + q.z*q.z), 2.0 * (q.y*q.z - q.x*q.w),
            2.0 * (q.x*q.z - q.y*q.w), 2.0 * (q.y*q.z + q.x*q.w), 1.0 - 2.0 * (q.x*q.x + q.y*q.y)
          );

          vec3 quadSize = exp(clamp(splatScale, -10.0, 5.0)) * 1.5;
          vec3 quadPos = rotMat * (position * quadSize);
          
          gl_Position = projectionMatrix * viewMatrix * worldPos + vec4(quadPos.xy, 0.0, 0.0);

          // GUAVA仕様：32次元潜在特徴量の最初の3chを Coarse RGB として出力
          vColor = splatColor; 
          // 透過率：論文仕様の Sigmoid 活性化を適用
          vAlpha = 1.0 / (1.0 + exp(-clamp(splatOpacity, -10.0, 10.0)));
          vPosition = position.xy;
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec3 vColor; varying float vAlpha; varying vec2 vPosition;
        void main() {
          float r2 = dot(vPosition, vPosition);
          if (r2 > 1.0) discard;
          gl_FragColor = vec4(vColor, vAlpha * exp(-r2 * 2.0));
        }
      `,
      transparent: true, depthWrite: false, blending: THREE.NormalBlending
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
  }
}
