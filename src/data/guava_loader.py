import os
import torch
from torch.utils.data import Dataset, DataLoader
from torchvision import transforms
from PIL import Image

class GUAVADataset(Dataset):
    """
    GUAVAの素材（画像/テクスチャ/マップ）を読み込むデータセットクラス
    """
    def __init__(self, root_dir, img_size=(512, 512)):
        self.root_dir = root_dir
        self.img_size = img_size
        # 対応する画像拡張子
        self.valid_extensions = ('.png', '.jpg', '.jpeg', '.webp')
        self.file_list = [f for f in os.listdir(root_dir) if f.lower().endswith(self.valid_extensions)]
        
        # StyleUNetに適した標準的な変換
        self.transform = transforms.Compose([
            transforms.Resize(self.img_size),
            transforms.ToTensor(),
            transforms.Normalize(mean=[0.5, 0.5, 0.5], std=[0.5, 0.5, 0.5]) # [-1, 1] に正規化
        ])

    def __len__(self):
        return len(self.file_list)

    def __getitem__(self, idx):
        img_name = self.file_list[idx]
        img_path = os.path.join(self.root_dir, img_name)
        
        # 画像の読み込み（RGBAの場合はRGBに変換、必要に応じて調整）
        image = Image.open(img_path).convert("RGB")
        
        if self.transform:
            image = self.transform(image)
            
        return image, img_name

def get_guava_loader(root_dir, batch_size=1, shuffle=True, img_size=(512, 512)):
    """
    エンジンの学習や推論に使用するDataLoaderを取得する関数
    """
    dataset = GUAVADataset(root_dir, img_size=img_size)
    return DataLoader(dataset, batch_size=batch_size, shuffle=shuffle)

if __name__ == "__main__":
    # テスト用コード（パスは適宜調整してください）
    sample_path = "./inputs/guava_assets"
    print(f"Searching for GUAVA materials in: {sample_path}")
    
    # フォルダが存在する場合のみ実行
    if os.path.exists(sample_path):
        loader = get_guava_loader(sample_path)
        for images, names in loader:
            print(f"Loaded batch: {names} | Shape: {images.shape}")
            break
    else:
        print("Note: Sample path not found. Please specify your GUAVA output directory.")
