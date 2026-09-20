package com.fri4666.bweeep.fabric;

import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.fabricmc.fabric.api.client.networking.v1.ClientConfigurationNetworking;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import net.minecraft.world.item.ItemStack;

final class DisplayNameScreen extends Screen {
    private static final int WIDTH = 360;
    private static final int HEIGHT = 248;
    private static final int PANEL = 0xFF211C17;
    private static final int EDGE = 0xFF8B6738;
    private static final int ACCENT = 0xFFD6973E;
    private static final int MUTED = 0xFFC8BCAE;
    private EditBox input;
    private Button primary;
    private Button secondary;
    private State state = State.INPUT;
    private String status = "";
    private final String gameName;
    private final boolean configurationPhase;

    DisplayNameScreen(String gameName, boolean configurationPhase) {
        super(Component.translatable("screen.bweeep_client.title"));
        this.gameName = gameName;
        this.configurationPhase = configurationPhase;
    }

    @Override
    protected void init() {
        int left = (width - WIDTH) / 2;
        int top = (height - HEIGHT) / 2;
        input = addRenderableWidget(new EditBox(font, left + 24, top + 79, WIDTH - 48, 22, title));
        input.setMaxLength(16);
        input.setResponder(value -> refresh());
        secondary = addRenderableWidget(Button.builder(Component.translatable("screen.bweeep_client.back"), b -> secondary())
            .bounds(left + 24, top + 216, 100, 22).build());
        primary = addRenderableWidget(Button.builder(Component.translatable("screen.bweeep_client.review"), b -> primary())
            .bounds(left + 130, top + 216, 206, 22).build());
        setInitialFocus(input);
        refresh();
    }

    private void primary() {
        if (state == State.SUCCESS) { super.onClose(); return; }
        String normalized = DisplayNameRules.normalize(input.getValue());
        if (state == State.INPUT || state == State.ERROR) {
            if (normalized == null) { state = State.ERROR; status = "사용할 수 없는 이름입니다."; refresh(); return; }
            input.setValue(normalized);
            state = State.CONFIRM;
            refresh();
            return;
        }
        if (state == State.CONFIRM) {
            state = State.SAVING;
            status = Component.translatable("screen.bweeep_client.saving").getString();
            refresh();
            if (configurationPhase) {
                ClientConfigurationNetworking.send(new BweeepProtocol.SubmitName(input.getValue()));
            } else {
                ClientPlayNetworking.send(new BweeepProtocol.SubmitName(input.getValue()));
            }
        }
    }

    private void secondary() {
        if (state == State.CONFIRM || state == State.ERROR) {
            state = State.INPUT;
            status = "";
            refresh();
        }
    }

    void handleResult(BweeepProtocol.DisplayNameResult payload) {
        state = payload.success() ? State.SUCCESS : State.ERROR;
        status = payload.message();
        if (payload.success()) input.setValue(payload.displayName());
        refresh();
    }

    private void refresh() {
        if (input == null) return;
        input.setEditable(state == State.INPUT || state == State.ERROR);
        secondary.visible = state == State.CONFIRM || state == State.ERROR;
        secondary.setMessage(Component.translatable("screen.bweeep_client.back"));
        primary.setX(secondary.visible ? ((width - WIDTH) / 2) + 130 : ((width - WIDTH) / 2) + 24);
        primary.setWidth(secondary.visible ? 206 : WIDTH - 48);
        primary.visible = state != State.SAVING;
        primary.active = state == State.CONFIRM || state == State.SUCCESS || DisplayNameRules.normalize(input.getValue()) != null;
        primary.setMessage(Component.translatable(state == State.CONFIRM
            ? "screen.bweeep_client.confirm" : "screen.bweeep_client.review"));
    }

    @Override
    public void render(GuiGraphics graphics, int mouseX, int mouseY, float partialTick) {
        // Avoid the menu blur here: in the configuration phase it can blur the
        // form itself. A solid scrim keeps the connection screen out of the way.
        graphics.fill(0, 0, width, height, 0xF2000000);
        int left = (width - WIDTH) / 2;
        int top = (height - HEIGHT) / 2;
        graphics.fill(left - 3, top - 3, left + WIDTH + 3, top + HEIGHT + 3, 0xFF080706);
        graphics.fill(left, top, left + WIDTH, top + HEIGHT, EDGE);
        graphics.fill(left + 2, top + 2, left + WIDTH - 2, top + HEIGHT - 2, PANEL);
        graphics.fill(left + 18, top + 15, left + 42, top + 39, 0xFF4D3822);
        graphics.renderItem(new ItemStack(BweeepFabric.NAME_TOKEN), left + 22, top + 19);
        graphics.drawCenteredString(font, Component.translatable("screen.bweeep_client.connecting"), width / 2, top + 17, ACCENT);
        graphics.drawCenteredString(font, title, width / 2, top + 34, 0xFFFFFFFF);
        graphics.drawCenteredString(font, Component.literal("Minecraft ID " + gameName), width / 2, top + 50, MUTED);
        graphics.drawString(font, Component.translatable("screen.bweeep_client.hint"), left + 24, top + 105, MUTED);
        graphics.fill(left + 24, top + 121, left + WIDTH - 24, top + 174, 0xFF201B16);
        String name = DisplayNameRules.normalize(input.getValue());
        if (name == null) name = "표시 이름";
        graphics.drawCenteredString(font, Component.literal(name), width / 2, top + 143, 0xFFFFFFFF);
        graphics.drawString(font, Component.literal("<" + name + "> 안녕하세요!"), left + 34, top + 160, 0xFFFFFFFF);
        String warning = state == State.CONFIRM
            ? "'" + input.getValue() + "'(으)로 등록할까요? 확정 후 변경할 수 없습니다."
            : state == State.INPUT ? "한 번만 설정할 수 있어요. 저장 성공 후 등록권이 사라집니다." : status;
        int y = top + 181;
        for (var line : font.split(Component.literal(warning), WIDTH - 66)) {
            graphics.drawString(font, line, left + 33, y, state == State.ERROR ? 0xFFFF8D84 : 0xFFE4D8CA);
            y += 10;
        }
        super.render(graphics, mouseX, mouseY, partialTick);
    }

    @Override public boolean isPauseScreen() { return false; }

    @Override public boolean shouldCloseOnEsc() { return state == State.SUCCESS; }

    @Override public void onClose() {
        if (state == State.SUCCESS) super.onClose();
    }

    private enum State { INPUT, CONFIRM, SAVING, SUCCESS, ERROR }
}
