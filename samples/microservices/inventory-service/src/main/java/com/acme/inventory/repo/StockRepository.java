package com.acme.inventory.repo;

import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface StockRepository extends JpaRepository<StockItem, Long> {
    Optional<StockItem> findBySku(String sku);
}
