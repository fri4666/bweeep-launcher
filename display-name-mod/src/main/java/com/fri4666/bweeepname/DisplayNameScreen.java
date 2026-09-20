package com.fri4666.bweeepname;

import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import net.minecraft.world.item.ItemStack;
import net.neoforged.neoforge.network.PacketDistributor;

final class DisplayNameScreen extends Screen {
    private static final int PANEL_WIDTH = 360;
    private static final int PANEL_HEIGHT = 248;
    private static final int PANEL = 0xFF211C17;
    private static final int PANEL_EDGE = 0xFF8B6738;
    private static final int ACCENT = 0xFFD6973E;
    private static final int MUTED = 0xFFC8BCAE;
    private static final int ERROR = 0xFFFF8D84;
    private static final int PREVIEW = 0xFF201B16;

    private EditBox input;
    private Button primary;
    private Button secondary;
    private State state = State.INPUT;
    private String message = "";
    private final String gameName;

    DisplayNameScreen(String gameName) {
        super(Component.translatable("screen.bweeep_display_name.title"));
        this.gameName = gameName;
    }

    @Override
    protected void init() {
        int left = (width - PANEL_WIDTH) / 2;
        int top = (height - PANEL_HEIGHT) / 2;
        input = new EditBox(font, left + 24, top + 79, PANEL_WIDTH - 48, 22, title);
        input.setMaxLength(16);
        input.setHint(Component.translatable("screen.bweeep_display_name.placeholder"));
        input.setResponder(ignored -> refreshButtons());
        addRenderableWidget(input);

        secondary = addRenderableWidget(Button.builder(
            Component.translatable("screen.bweeep_display_name.back"),
            button -> secondaryAction()
        ).bounds(left + 24, top + 216, 100, 22).build());
        primary = addRenderableWidget(Button.builder(
            Component.translatable("screen.bweeep_display_name.review"),
            button -> primaryAction()
        ).bounds(left + 130, top + 216, 206, 22).build());
        setInitialFocus(input);
        refreshButtons();
    }

    private void primaryAction() {
        if (state == State.SUCCESS) {
            super.onClose();
            return;
        }
        if (state == State.INPUT || state == State.ERROR) {
            String normalized = DisplayNameRules.normalize(input.getValue());
            if (normalized == null) {
                state = State.ERROR;
                message = Component.translatable("screen.bweeep_display_name.invalid").getString();
                refreshButtons();
                return;
            }
            input.setValue(normalized);
            state = State.CONFIRM;
            message = "";
            refreshButtons();
            return;
        }
        if (state == State.CONFIRM) {
            state = State.SAVING;
            message = Component.translatable("screen.bweeep_display_name.saving").getString();
            refreshButtons();
            PacketDistributor.sendToServer(new SubmitNamePayload(input.getValue()));
        }
    }

    private void secondaryAction() {
        if (state == State.CONFIRM || state == State.ERROR) {
            state = State.INPUT;
            message = "";
            refreshButtons();
            setFocused(input);
            return;
        }
        // The connection remains in its configuration phase until a name is saved.
    }

    void handleResult(DisplayNameResultPayload payload) {
        state = payload.success() ? State.SUCCESS : State.ERROR;
        message = payload.message();
        if (payload.success()) input.setValue(payload.displayName());
        refreshButtons();
    }

    private void refreshButtons() {
        if (input == null || primary == null || secondary == null) return;
        boolean editable = state == State.INPUT || state == State.ERROR;
        input.setEditable(editable);
        input.setTextColor(editable ? 0xFFF4EADB : 0xFFB5A999);
        secondary.visible = state == State.CONFIRM || state == State.ERROR;
        secondary.setMessage(Component.translatable("screen.bweeep_display_name.back"));
        primary.setX(secondary.visible ? ((width - PANEL_WIDTH) / 2) + 130 : ((width - PANEL_WIDTH) / 2) + 24);
        primary.setWidth(secondary.visible ? 206 : PANEL_WIDTH - 48);
        primary.visible = state != State.SAVING;
        primary.active = state == State.SUCCESS || state == State.CONFIRM || DisplayNameRules.normalize(input.getValue()) != null;
        primary.setMessage(Component.translatable(switch (state) {
            case CONFIRM -> "screen.bweeep_display_name.confirm";
            case SUCCESS -> "screen.bweeep_display_name.done";
            default -> "screen.bweeep_display_name.review";
        }));
    }

    @Override
    public void render(GuiGraphics graphics, int mouseX, int mouseY, float partialTick) {
        // Screen#renderBackground applies Minecraft's menu blur. During the
        // configuration phase that blur can be composited over this screen too,
        // making the form unreadable. Use a solid scrim and opaque card instead.
        graphics.fill(0, 0, width, height, 0xF2000000);
        int left = (width - PANEL_WIDTH) / 2;
        int top = (height - PANEL_HEIGHT) / 2;

        graphics.fill(left - 3, top - 3, left + PANEL_WIDTH + 3, top + PANEL_HEIGHT + 3, 0xFF080706);
        graphics.fill(left, top, left + PANEL_WIDTH, top + PANEL_HEIGHT, PANEL_EDGE);
        graphics.fill(left + 2, top + 2, left + PANEL_WIDTH - 2, top + PANEL_HEIGHT - 2, PANEL);

        graphics.fill(left + 18, top + 15, left + 42, top + 39, 0xFF4D3822);
        graphics.renderItem(new ItemStack(BweeepDisplayNameMod.NAME_TOKEN.get()), left + 22, top + 19);

        graphics.drawCenteredString(
            font,
            Component.translatable("screen.bweeep_display_name.connecting"),
            width / 2,
            top + 17,
            ACCENT
        );
        graphics.drawCenteredString(font, title, width / 2, top + 34, 0xFFFFFFFF);
        graphics.drawCenteredString(
            font,
            Component.translatable("screen.bweeep_display_name.identity", gameName),
            width / 2,
            top + 50,
            MUTED
        );

        graphics.drawString(font, Component.translatable("screen.bweeep_display_name.label"), left + 24, top + 67, 0xFFFFFFFF);
        graphics.drawString(font, Component.literal(codePointCount() + "/16"), left + PANEL_WIDTH - 50, top + 67, MUTED);
        graphics.drawString(font, Component.translatable("screen.bweeep_display_name.hint"), left + 24, top + 105, MUTED);

        graphics.fill(left + 24, top + 121, left + PANEL_WIDTH - 24, top + 174, PREVIEW);
        graphics.drawString(font, Component.translatable("screen.bweeep_display_name.preview"), left + 34, top + 129, MUTED);
        String previewName = DisplayNameRules.normalize(input.getValue());
        if (previewName == null) previewName = Component.translatable("screen.bweeep_display_name.preview_empty").getString();
        int nameWidth = font.width(previewName);
        graphics.fill(width / 2 - nameWidth / 2 - 5, top + 141, width / 2 + nameWidth / 2 + 5, top + 154, 0xFF101010);
        graphics.drawCenteredString(font, Component.literal(previewName), width / 2, top + 143, 0xFFFFFFFF);
        graphics.drawString(font, Component.literal("<" + previewName + "> 안녕하세요!"), left + 34, top + 160, 0xFFFFFFFF);

        int warningColor = state == State.ERROR ? ERROR : ACCENT;
        graphics.drawString(font, Component.literal("!"), left + 26, top + 184, warningColor);
        Component warning = switch (state) {
            case CONFIRM -> Component.translatable("screen.bweeep_display_name.confirm_warning", input.getValue());
            case SAVING -> Component.translatable("screen.bweeep_display_name.saving");
            case SUCCESS -> Component.literal(message);
            case ERROR -> Component.literal(message);
            default -> Component.translatable("screen.bweeep_display_name.once_warning");
        };
        int y = top + 181;
        for (var line : font.split(warning, PANEL_WIDTH - 70)) {
            graphics.drawString(font, line, left + 42, y, state == State.ERROR ? ERROR : 0xFFE4D8CA);
            y += 10;
        }

        super.render(graphics, mouseX, mouseY, partialTick);
    }

    private int codePointCount() {
        String value = input == null ? "" : input.getValue();
        return value.codePointCount(0, value.length());
    }

    @Override
    public boolean isPauseScreen() {
        return false;
    }

    @Override
    public boolean shouldCloseOnEsc() {
        return state == State.SUCCESS;
    }

    @Override
    public void onClose() {
        if (state == State.SUCCESS) super.onClose();
    }

    private enum State {
        INPUT,
        CONFIRM,
        SAVING,
        SUCCESS,
        ERROR
    }
}
