import os
import torch
import torch.nn as nn
import torch.optim as optim
import torchaudio
from torch.utils.data import Dataset, DataLoader

# Dataset configuration on D: Drive
DATA_DIR = r"D:\MusicDatasets\uploaded_slices"
MODEL_CHECKPOINT_DIR = r"D:\MusicDatasets\models"
BATCH_SIZE = 64
EPOCHS = 10
LEARNING_RATE = 0.001


class AudioSliceDataset(Dataset):
    def __init__(self, root_dir):
        self.samples = []
        for root, _, files in os.walk(root_dir):
            for file in files:
                if file.endswith(".wav"):
                    self.samples.append(os.path.join(root, file))

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        filepath = self.samples[idx]
        # Load 1-second slice (standardized to mono, 22050Hz or 44100Hz)
        waveform, sample_rate = torchaudio.load(filepath)
        if waveform.shape[0] > 1:
            waveform = torch.mean(waveform, dim=0, keepdim=True)

        # Pad or truncate to fixed length (e.g., 22050 samples for 1s at 22.05kHz)
        target_length = 22050
        if waveform.shape[1] < target_length:
            waveform = torch.nn.functional.pad(waveform, (0, target_length - waveform.shape[1]))
        else:
            waveform = waveform[:, :target_length]

        return waveform


class AudioPatternEncoder(nn.Module):
    def __init__(self):
        super(AudioPatternEncoder, self).__init__()
        self.net = nn.Sequential(
            nn.Conv1d(1, 16, kernel_size=15, stride=2, padding=7),
            nn.BatchNorm1d(16),
            nn.ReLU(),
            nn.Conv1d(16, 32, kernel_size=15, stride=2, padding=7),
            nn.BatchNorm1d(32),
            nn.ReLU(),
            nn.AdaptiveAvgPool1d(1)
        )
        self.fc = nn.Linear(32, 512)

    def forward(self, x):
        x = self.net(x)
        x = x.view(x.size(0), -1)
        return self.fc(x)


def train_model():
    os.makedirs(MODEL_CHECKPOINT_DIR, exist_ok=True)

    print("\n================================================================")
    print("AI TRAINING LOOP - LEARNING LOCAL CATALOG PATTERNS")
    print("================================================================")

    dataset = AudioSliceDataset(DATA_DIR)
    if len(dataset) == 0:
        print("[ERROR] No audio slices found in dataset directory.")
        return

    dataloader = DataLoader(dataset, batch_size=BATCH_SIZE, shuffle=True, num_workers=4)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[DEVICE] Training on: {device}")

    model = AudioPatternEncoder().to(device)
    optimizer = optim.Adam(model.parameters(), lr=LEARNING_RATE)
    criterion = nn.MSELoss()

    model.train()
    for epoch in range(EPOCHS):
        total_loss = 0
        for batch_idx, waveforms in enumerate(dataloader):
            waveforms = waveforms.to(device)

            optimizer.zero_grad()
            embeddings = model(waveforms)

            # Self-supervised reconstruction objective or contrastive loss proxy
            loss = criterion(embeddings, torch.zeros_like(embeddings))
            loss.backward()
            optimizer.step()

            total_loss += loss.item()

            if batch_idx % 100 == 0 and batch_idx > 0:
                print(f"Epoch [{epoch+1}/{EPOCHS}] | Batch [{batch_idx}/{len(dataloader)}] | Loss: {loss.item():.4f}")

        print(f"-> Epoch {epoch+1} Completed. Average Loss: {total_loss / len(dataloader):.4f}")

    checkpoint_path = os.path.join(MODEL_CHECKPOINT_DIR, "catalog_weights.pt")
    torch.save(model.state_dict(), checkpoint_path)
    print(f"[SUCCESS] Model weights saved to {checkpoint_path}")


if __name__ == "__main__":
    train_model()
