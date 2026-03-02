import onnx
import sys

model_path = "public/assets/refiner_websafe_v1.onnx"

try:
    # モデルをロード
    model = onnx.load(model_path)
    
    print("=" * 80)
    print("ONNX Model Information")
    print("=" * 80)
    
    # 基本情報
    print(f"\nModel path: {model_path}")
    print(f"IR version: {model.ir_version}")
    print(f"Producer: {model.producer_name} {model.producer_version}")
    print(f"Opset version: {model.opset_import[0].version}")
    
    # 入力情報
    print("\n" + "=" * 80)
    print("INPUTS:")
    print("=" * 80)
    for input_tensor in model.graph.input:
        print(f"\nName: {input_tensor.name}")
        print(f"Type: {input_tensor.type.tensor_type.elem_type}")
        shape = []
        for dim in input_tensor.type.tensor_type.shape.dim:
            if dim.dim_value:
                shape.append(dim.dim_value)
            elif dim.dim_param:
                shape.append(dim.dim_param)
            else:
                shape.append('?')
        print(f"Shape: {shape}")
    
    # 出力情報
    print("\n" + "=" * 80)
    print("OUTPUTS:")
    print("=" * 80)
    for output_tensor in model.graph.output:
        print(f"\nName: {output_tensor.name}")
        print(f"Type: {output_tensor.type.tensor_type.elem_type}")
        shape = []
        for dim in output_tensor.type.tensor_type.shape.dim:
            if dim.dim_value:
                shape.append(dim.dim_value)
            elif dim.dim_param:
                shape.append(dim.dim_param)
            else:
                shape.append('?')
        print(f"Shape: {shape}")
    
    print("\n" + "=" * 80)
    
except Exception as e:
    print(f"Error loading model: {e}")
    sys.exit(1)