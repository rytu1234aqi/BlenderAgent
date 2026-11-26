import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export interface SceneStats {
  meshes: number;
  vertices: number;
  triangles: number;
}

function isPresentationObject(object: THREE.Object3D): boolean {
  return object.name === "demo_floor" || object.name.startsWith("Preview_");
}

function assetBounds(root: THREE.Object3D): THREE.Box3 {
  const bounds = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || isPresentationObject(object)) return;
    mesh.geometry.computeBoundingBox();
    if (!mesh.geometry.boundingBox) return;
    bounds.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
  });
  return bounds;
}

export class SceneViewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly loader = new GLTFLoader();
  private readonly observer: ResizeObserver;
  private readonly environmentTarget: THREE.WebGLRenderTarget;
  private root: THREE.Object3D | null = null;
  private raf = 0;
  private disposed = false;
  private wireframe = false;
  private loadSequence = 0;

  onStats?: (stats: SceneStats) => void;
  onLoading?: (loading: boolean) => void;
  onError?: (message: string) => void;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth || 1, container.clientHeight || 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.outline = "none";
    this.renderer.domElement.setAttribute("aria-label", "已验证 Blender 交付的交互式 3D 预览");
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x10151b);
    this.camera = new THREE.PerspectiveCamera(45, (container.clientWidth || 1) / (container.clientHeight || 1), 0.02, 2000);
    this.camera.position.set(3, 2.5, 4);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 1, 0);
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 0.15;
    this.controls.maxDistance = 100;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environmentTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = this.environmentTarget.texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

    const hemisphere = new THREE.HemisphereLight(0xddebf2, 0x17212a, 1.15);
    this.scene.add(hemisphere);
    const key = new THREE.DirectionalLight(0xf2f5f6, 2.4);
    key.position.set(4, 7, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.1;
    key.shadow.camera.far = 30;
    key.shadow.camera.left = -6;
    key.shadow.camera.right = 6;
    key.shadow.camera.top = 6;
    key.shadow.camera.bottom = -6;
    key.shadow.bias = -0.0005;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fb7c9, 0.65);
    rim.position.set(-4, 3, -4);
    this.scene.add(rim);
    const grid = new THREE.GridHelper(12, 24, 0x34434e, 0x202b34);
    const gridMaterial = grid.material as THREE.LineBasicMaterial;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.55;
    this.scene.add(grid);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    const animate = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(animate);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  private resize(): void {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  async load(url: string): Promise<void> {
    const sequence = ++this.loadSequence;
    this.onLoading?.(true);
    try {
      const gltf = await this.loader.loadAsync(url);
      if (this.disposed || sequence !== this.loadSequence) {
        disposeObject(gltf.scene);
        return;
      }
      if (this.root) {
        this.scene.remove(this.root);
        disposeObject(this.root);
      }
      this.root = gltf.scene;
      this.root.traverse((object) => {
        if (isPresentationObject(object)) object.visible = false;
        if ((object as THREE.Mesh).isMesh && object.visible) {
          object.castShadow = true;
          object.receiveShadow = true;
        }
      });
      this.applyWireframe();
      this.scene.add(this.root);
      this.onStats?.(computeStats(this.root));
      this.frameAll();
    } catch (error) {
      if (sequence === this.loadSequence) this.onError?.((error as Error).message || "模型加载失败");
    } finally {
      if (!this.disposed && sequence === this.loadSequence) this.onLoading?.(false);
    }
  }

  frameAll(): void {
    if (!this.root) return;
    const box = assetBounds(this.root);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 0.4);
    const distance = (radius / Math.sin((this.camera.fov * Math.PI / 180) / 2)) * 1.3;
    const direction = new THREE.Vector3(1, 0.62, 1).normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.near = Math.max(distance / 1000, 0.005);
    this.camera.far = Math.max(distance * 100, 100);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  setWireframe(on: boolean): void {
    this.wireframe = on;
    this.applyWireframe();
  }

  private applyWireframe(): void {
    this.root?.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (material && "wireframe" in material) (material as THREE.MeshStandardMaterial).wireframe = this.wireframe;
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.loadSequence += 1;
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    this.controls.dispose();
    if (this.root) disposeObject(this.root);
    this.environmentTarget.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function computeStats(root: THREE.Object3D): SceneStats {
  let meshes = 0;
  let vertices = 0;
  let triangles = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || isPresentationObject(object)) return;
    meshes += 1;
    const position = mesh.geometry.getAttribute("position");
    if (position) vertices += position.count;
    if (mesh.geometry.index) triangles += mesh.geometry.index.count / 3;
    else if (position) triangles += position.count / 3;
  });
  return { meshes, vertices, triangles: Math.round(triangles) };
}

function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    const values = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of values) if (material) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}
