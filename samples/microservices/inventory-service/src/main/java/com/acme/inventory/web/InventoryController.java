package com.acme.inventory.web;

import com.acme.inventory.service.InventoryService;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/inventory")
public class InventoryController {

    private final InventoryService inventoryService;

    public InventoryController(InventoryService inventoryService) {
        this.inventoryService = inventoryService;
    }

    @GetMapping("/{sku}")
    public int available(@PathVariable String sku) {
        return inventoryService.available(sku);
    }

    @PostMapping("/{sku}/reserve")
    public void reserve(@PathVariable String sku, @RequestParam("qty") int qty) {
        inventoryService.reserve(sku, qty);
    }

    @DeleteMapping("/reservations/{orderId}")
    public void release(@PathVariable Long orderId) {
        inventoryService.release(orderId);
    }
}
