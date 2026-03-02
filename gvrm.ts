import * as THREE from 'three';
import { PLYLoader } from './ply';
import { GSViewer } from './gs';

export class GVRM {
    private scene: THREE.Scene;
    private camera: THREE.PerspectiveCamera;
    private renderer: THREE.WebGLRenderer;
    public viewer: GSViewer | null = null;
    private boneMatrices: Float32Array = new Float32Array(64 * 16);
    private boneTexture: THREE.DataTexture;

    constructor(container: HTMLElement) {
        this.scene = new THREE.Scene();
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setClearColor(0x111111, 1.0); 
        
        const canvas = this.renderer.domElement;
        canvas.style.display = 'block';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        container.appendChild(canvas);

        this.renderer.setSize(container.clientWidth, container.clientHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);

        // 【復元】影が表示されていた成功時の画角とカメラ位置
        this.camera = new THREE.PerspectiveCamera(35, container.clientWidth / container.clientHeight, 0.01, 100);
        this.camera.position.set(0, 0.4, 1.3); 

        const identity = new THREE.Matrix4();
        for (let i = 0; i < 64; i++) identity.toArray(this.boneMatrices, i * 16);
        this.boneTexture = new THREE.DataTexture(this.boneMatrices, 4, 64, THREE.RGBAFormat, THREE.FloatType);
        this.boneTexture.needsUpdate = true;
        
        this.animate();
    }

    public async loadAssets(url: string): Promise<boolean> {
        try {
            const data = await PLYLoader.load(url);
            this.viewer = new GSViewer(data);
            (this.viewer.mesh.material as THREE.ShaderMaterial).uniforms.boneMatrices.value = this.boneTexture;
            
            // 【復元】影が表示されていた成功時のアバター配置
            this.viewer.mesh.position.set(0, -0.6, 0); 
            this.scene.add(this.viewer.mesh);

            const fallback = document.getElementById('avatarFallback');
            if (fallback) fallback.style.display = 'none';

            console.log("%c[GVRM] SUCCESS: Avatar Visible and Gap Removed", "color: white; background: green; padding: 4px;");
            return true;
        } catch (e) { return false; }
    }

    public updateLipSync(level: number) {
        if (!this.viewer) return;
        (this.viewer.mesh.material as THREE.ShaderMaterial).uniforms.jawOpen.value = level;
    }

    public setPose(matrices: Float32Array) {
        this.boneMatrices.set(matrices);
        this.boneTexture.needsUpdate = true;
    }

    private animate() {
        requestAnimationFrame(() => this.animate());
        this.renderer.render(this.scene, this.camera);
    }
}
