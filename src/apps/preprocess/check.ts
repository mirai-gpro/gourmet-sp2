export class DataCheck {
    static validate(header: string) {
        return header.includes("property float rot_0") && header.includes("property float scale_0");
    }
}
