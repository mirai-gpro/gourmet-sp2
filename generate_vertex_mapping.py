#!/usr/bin/env python3
"""
PLY頂点からTemplate頂点への最近傍マッピングを事前計算するスクリプト
出力: vertex_mapping.json (PLY頂点インデックス → Template頂点インデックス)

使用方法:
  python generate_vertex_mapping.py <ply_file> <v_template.bin> <output.json>

例:
  python generate_vertex_mapping.py ../public/assets/avatar_canonical.ply ../public/assets/v_template.bin ../public/assets/vertex_mapping.json
"""

import numpy as np
import json
import struct
import sys
from pathlib import Path

def load_ply_vertices(ply_path: str) -> np.ndarray:
    """PLYファイルから頂点座標を読み込む"""
    with open(ply_path, 'rb') as f:
        # ヘッダー解析
        header_lines = []
        while True:
            line = f.readline().decode('utf-8').strip()
            header_lines.append(line)
            if line == 'end_header':
                break

        # 頂点数を取得
        vertex_count = 0
        properties = []
        for line in header_lines:
            if line.startswith('element vertex'):
                vertex_count = int(line.split()[-1])
            elif line.startswith('property'):
                parts = line.split()
                dtype = parts[1]
                name = parts[2]
                properties.append((dtype, name))

        print(f"[PLY] Vertex count: {vertex_count}")
        print(f"[PLY] Properties: {[p[1] for p in properties]}")

        # プロパティのサイズを計算
        dtype_sizes = {
            'float': 4, 'double': 8,
            'int': 4, 'uint': 4,
            'short': 2, 'ushort': 2,
            'char': 1, 'uchar': 1
        }

        # x, y, zのインデックスとデータ型を見つける
        x_idx = y_idx = z_idx = -1
        x_dtype = y_dtype = z_dtype = 'float'
        offset = 0
        prop_offsets = []

        for i, (dtype, name) in enumerate(properties):
            prop_offsets.append(offset)
            if name == 'x':
                x_idx = i
                x_dtype = dtype
            elif name == 'y':
                y_idx = i
                y_dtype = dtype
            elif name == 'z':
                z_idx = i
                z_dtype = dtype
            offset += dtype_sizes.get(dtype, 4)

        stride = offset
        print(f"[PLY] Stride: {stride} bytes")

        # 頂点データを読み込み
        vertices = np.zeros((vertex_count, 3), dtype=np.float64)

        for i in range(vertex_count):
            vertex_data = f.read(stride)

            # x, y, z を読み取り
            def read_value(data, prop_idx, dtype):
                off = prop_offsets[prop_idx]
                if dtype == 'double':
                    return struct.unpack('<d', data[off:off+8])[0]
                elif dtype == 'float':
                    return struct.unpack('<f', data[off:off+4])[0]
                else:
                    return struct.unpack('<f', data[off:off+4])[0]

            vertices[i, 0] = read_value(vertex_data, x_idx, x_dtype)
            vertices[i, 1] = read_value(vertex_data, y_idx, y_dtype)
            vertices[i, 2] = read_value(vertex_data, z_idx, z_dtype)

        return vertices


def load_template_vertices(bin_path: str) -> np.ndarray:
    """v_template.binからテンプレート頂点を読み込む"""
    with open(bin_path, 'rb') as f:
        data = np.frombuffer(f.read(), dtype=np.float32)

    # 10595頂点 × 3座標
    vertex_count = len(data) // 3
    vertices = data.reshape((vertex_count, 3))

    print(f"[Template] Vertex count: {vertex_count}")
    return vertices


def compute_nearest_neighbor_mapping(ply_vertices: np.ndarray, template_vertices: np.ndarray) -> np.ndarray:
    """PLY頂点ごとに最近傍のTemplate頂点インデックスを計算"""
    from scipy.spatial import KDTree

    print(f"[Mapping] Building KD-Tree for {len(template_vertices)} template vertices...")
    tree = KDTree(template_vertices)

    print(f"[Mapping] Finding nearest neighbors for {len(ply_vertices)} PLY vertices...")
    distances, indices = tree.query(ply_vertices, k=1)

    print(f"[Mapping] Done. Distance stats: min={distances.min():.6f}, max={distances.max():.6f}, mean={distances.mean():.6f}")

    return indices.astype(np.int32)


def main():
    if len(sys.argv) != 4:
        print("Usage: python generate_vertex_mapping.py <ply_file> <v_template.bin> <output.json>")
        print("Example: python generate_vertex_mapping.py avatar_canonical.ply v_template.bin vertex_mapping.json")
        sys.exit(1)

    ply_path = sys.argv[1]
    template_path = sys.argv[2]
    output_path = sys.argv[3]

    print(f"Loading PLY: {ply_path}")
    ply_vertices = load_ply_vertices(ply_path)

    print(f"Loading Template: {template_path}")
    template_vertices = load_template_vertices(template_path)

    print("Computing nearest neighbor mapping...")
    mapping = compute_nearest_neighbor_mapping(ply_vertices, template_vertices)

    # JSON出力
    output = {
        "description": "PLY vertex to Template vertex mapping (nearest neighbor)",
        "plyFile": Path(ply_path).name,
        "templateFile": Path(template_path).name,
        "plyVertexCount": len(ply_vertices),
        "templateVertexCount": len(template_vertices),
        "mapping": mapping.tolist()
    }

    print(f"Saving mapping to: {output_path}")
    with open(output_path, 'w') as f:
        json.dump(output, f)

    # ファイルサイズ確認
    file_size = Path(output_path).stat().st_size
    print(f"Output file size: {file_size / 1024:.1f} KB")
    print("Done!")


if __name__ == '__main__':
    main()
